package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const sessionCookie = "damed_admin"
const sessionDuration = 8 * time.Hour
const maxBodyBytes = 1 << 20

type Board struct {
	Clinic  Clinic  `json:"clinic"`
	Doctors []Doctor `json:"doctors"`
	Rooms   []Room   `json:"rooms"`
}

type Clinic struct {
	Name     string `json:"name"`
	Address  string `json:"address"`
	City     string `json:"city"`
	Timezone string `json:"timezone"`
}

type Doctor struct {
	ID             string            `json:"id"`
	Specialization string            `json:"specialization"`
	FullName       string            `json:"fullName"`
	Room           string            `json:"room"`
	Schedule       map[string]string `json:"schedule"`
}

type Room struct {
	ID     string `json:"id"`
	Number string `json:"number"`
	Name   string `json:"name"`
	Floor  string `json:"floor"`
}

type API struct {
	db *pgxpool.Pool
}

type attempt struct {
	count int
	start time.Time
}

var loginAttempts = struct {
	sync.Mutex
	byIP map[string]attempt
}{byIP: make(map[string]attempt)}

func main() {
	ctx := context.Background()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	var pool *pgxpool.Pool
	var err error
	for i := 0; i < 30; i++ {
		pool, err = pgxpool.New(ctx, databaseURL)
		if err == nil {
			err = pool.Ping(ctx)
			if err == nil {
				break
			}
			pool.Close()
		}
		if i == 29 {
			log.Fatalf("connect to database: %v", err)
		}
		time.Sleep(time.Second)
	}
	defer pool.Close()

	if err := migrate(ctx, pool); err != nil {
		log.Fatalf("initialize database: %v", err)
	}

	api := &API{db: pool}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", api.health)
	mux.HandleFunc("GET /api/board", api.getBoard)
	mux.HandleFunc("PUT /api/board", api.saveBoard)
	mux.HandleFunc("GET /api/session", api.getSession)
	mux.HandleFunc("POST /api/session", api.createSession)
	mux.HandleFunc("DELETE /api/session", api.deleteSession)

	if staticDir := os.Getenv("STATIC_DIR"); staticDir != "" {
		mux.Handle("GET /assets/", http.StripPrefix("/", http.FileServer(http.Dir(staticDir))))
		mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
		})
		mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
		})
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("DAMED schedule API listening on :%s", port)
	log.Fatal(server.ListenAndServe())
}

func migrate(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`
		CREATE TABLE IF NOT EXISTS clinic_settings (
			id SMALLINT PRIMARY KEY CHECK (id = 1),
			name TEXT NOT NULL DEFAULT 'DAMED-2020',
			address TEXT NOT NULL DEFAULT '',
			city TEXT NOT NULL DEFAULT 'Алматы',
			timezone TEXT NOT NULL DEFAULT 'Asia/Almaty',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`
		CREATE TABLE IF NOT EXISTS doctors (
			id TEXT PRIMARY KEY,
			specialization TEXT NOT NULL,
			full_name TEXT NOT NULL,
			room TEXT NOT NULL DEFAULT '',
			schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
			position INTEGER NOT NULL DEFAULT 0
		)`,
		`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			number TEXT NOT NULL,
			name TEXT NOT NULL,
			floor TEXT NOT NULL DEFAULT '',
			position INTEGER NOT NULL DEFAULT 0
		)`,
		`ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY`,
		`ALTER TABLE doctors ENABLE ROW LEVEL SECURITY`,
		`ALTER TABLE rooms ENABLE ROW LEVEL SECURITY`,
		`INSERT INTO clinic_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	if err := a.db.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "База данных временно недоступна.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) getBoard(w http.ResponseWriter, r *http.Request) {
	var board Board
	var updatedAt time.Time
	err := a.db.QueryRow(r.Context(), `SELECT name, address, city, timezone, updated_at FROM clinic_settings WHERE id = 1`).Scan(
		&board.Clinic.Name, &board.Clinic.Address, &board.Clinic.City, &board.Clinic.Timezone, &updatedAt,
	)
	if err != nil {
		log.Printf("load clinic settings: %v", err)
		writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить расписание. Попробуйте позже.")
		return
	}

	board.Doctors = make([]Doctor, 0)
	doctorRows, err := a.db.Query(r.Context(), `SELECT id, specialization, full_name, room, schedule FROM doctors ORDER BY position, full_name`)
	if err != nil {
		log.Printf("load doctors: %v", err)
		writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить расписание. Попробуйте позже.")
		return
	}
	for doctorRows.Next() {
		var doctor Doctor
		var schedule []byte
		if err := doctorRows.Scan(&doctor.ID, &doctor.Specialization, &doctor.FullName, &doctor.Room, &schedule); err != nil {
			doctorRows.Close()
			log.Printf("read doctor: %v", err)
			writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить расписание. Попробуйте позже.")
			return
		}
		if err := json.Unmarshal(schedule, &doctor.Schedule); err != nil {
			doctorRows.Close()
			log.Printf("decode doctor schedule: %v", err)
			writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить расписание. Попробуйте позже.")
			return
		}
		board.Doctors = append(board.Doctors, doctor)
	}
	if err := doctorRows.Err(); err != nil {
		doctorRows.Close()
		log.Printf("iterate doctors: %v", err)
		writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить расписание. Попробуйте позже.")
		return
	}
	doctorRows.Close()

	board.Rooms = make([]Room, 0)
	roomRows, err := a.db.Query(r.Context(), `SELECT id, number, name, floor FROM rooms ORDER BY position, number`)
	if err != nil {
		log.Printf("load rooms: %v", err)
		writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить кабинеты. Попробуйте позже.")
		return
	}
	defer roomRows.Close()
	for roomRows.Next() {
		var room Room
		if err := roomRows.Scan(&room.ID, &room.Number, &room.Name, &room.Floor); err != nil {
			log.Printf("read room: %v", err)
			writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить кабинеты. Попробуйте позже.")
			return
		}
		board.Rooms = append(board.Rooms, room)
	}
	if err := roomRows.Err(); err != nil {
		log.Printf("iterate rooms: %v", err)
		writeError(w, http.StatusServiceUnavailable, "Не удалось загрузить кабинеты. Попробуйте позже.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"board": board, "updatedAt": updatedAt})
}

func (a *API) saveBoard(w http.ResponseWriter, r *http.Request) {
	if !a.hasAdminSession(r) {
		writeError(w, http.StatusUnauthorized, "Войдите в панель администратора.")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var payload struct {
		Board Board `json:"board"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "Не удалось прочитать расписание.")
		return
	}
	if err := validateBoard(payload.Board); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("start save transaction: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить изменения.")
		return
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `UPDATE clinic_settings SET name=$1, address=$2, city=$3, timezone=$4, updated_at=NOW() WHERE id=1`,
		strings.TrimSpace(payload.Board.Clinic.Name), strings.TrimSpace(payload.Board.Clinic.Address),
		strings.TrimSpace(payload.Board.Clinic.City), strings.TrimSpace(payload.Board.Clinic.Timezone))
	if err == nil {
		_, err = tx.Exec(ctx, `DELETE FROM doctors`)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `DELETE FROM rooms`)
	}
	if err == nil {
		for index, doctor := range payload.Board.Doctors {
			schedule, marshalErr := json.Marshal(doctor.Schedule)
			if marshalErr != nil {
				err = marshalErr
				break
			}
			_, err = tx.Exec(ctx, `INSERT INTO doctors (id, specialization, full_name, room, schedule, position) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
				strings.TrimSpace(doctor.ID), strings.TrimSpace(doctor.Specialization), strings.TrimSpace(doctor.FullName), strings.TrimSpace(doctor.Room), string(schedule), index)
			if err != nil {
				break
			}
		}
	}
	if err == nil {
		for index, room := range payload.Board.Rooms {
			_, err = tx.Exec(ctx, `INSERT INTO rooms (id, number, name, floor, position) VALUES ($1, $2, $3, $4, $5)`,
				strings.TrimSpace(room.ID), strings.TrimSpace(room.Number), strings.TrimSpace(room.Name), strings.TrimSpace(room.Floor), index)
			if err != nil {
				break
			}
		}
	}
	if err != nil {
		log.Printf("save schedule: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить изменения.")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("commit schedule: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить изменения.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updatedAt": time.Now().UTC()})
}

func (a *API) getSession(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": a.hasAdminSession(r)})
}

func (a *API) createSession(w http.ResponseWriter, r *http.Request) {
	if !allowLoginAttempt(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "Слишком много попыток. Подождите 15 минут.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var payload struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Password) > 256 {
		writeError(w, http.StatusBadRequest, "Введите пароль.")
		return
	}
	expected := os.Getenv("ADMIN_PASSWORD")
	if expected == "" {
		writeError(w, http.StatusServiceUnavailable, "Пароль администратора не настроен.")
		return
	}
	if !hmac.Equal([]byte(payload.Password), []byte(expected)) {
		writeError(w, http.StatusUnauthorized, "Неверный пароль.")
		return
	}
	clearLoginAttempts(clientIP(r))
	setSessionCookie(w, makeSessionToken(time.Now().Add(sessionDuration)))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) deleteSession(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/api", HttpOnly: true, Secure: secureCookies(),
		SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

func validateBoard(board Board) error {
	if len(board.Doctors) > 100 || len(board.Rooms) > 100 {
		return errors.New("Можно добавить не более 100 врачей и кабинетов.")
	}
	if !validText(board.Clinic.Name, 100) || !validText(board.Clinic.Address, 160) || !validText(board.Clinic.City, 80) || !validText(board.Clinic.Timezone, 80) {
		return errors.New("Проверьте название клиники, адрес, город и часовой пояс.")
	}
	ids := make(map[string]bool)
	for _, doctor := range board.Doctors {
		if !validText(doctor.ID, 80) || !validText(doctor.Specialization, 100) || !validText(doctor.FullName, 140) || !validText(doctor.Room, 20) {
			return errors.New("Проверьте ФИО, специальность и кабинет врача.")
		}
		if ids[doctor.ID] {
			return errors.New("У врачей должны быть разные идентификаторы.")
		}
		ids[doctor.ID] = true
		for _, day := range []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"} {
			if !validText(doctor.Schedule[day], 30) {
				return errors.New("Проверьте время приёма врачей.")
			}
		}
	}
	ids = make(map[string]bool)
	for _, room := range board.Rooms {
		if !validText(room.ID, 80) || !validText(room.Number, 20) || !validText(room.Name, 100) || !validText(room.Floor, 40) {
			return errors.New("Проверьте номер, назначение и этаж кабинета.")
		}
		if ids[room.ID] {
			return errors.New("У кабинетов должны быть разные идентификаторы.")
		}
		ids[room.ID] = true
	}
	return nil
}

func validText(value string, max int) bool {
	return len([]rune(value)) <= max
}

func allowLoginAttempt(ip string) bool {
	now := time.Now()
	loginAttempts.Lock()
	defer loginAttempts.Unlock()
	entry := loginAttempts.byIP[ip]
	if now.Sub(entry.start) >= 15*time.Minute || entry.start.IsZero() {
		entry = attempt{start: now}
	}
	if entry.count >= 8 {
		loginAttempts.byIP[ip] = entry
		return false
	}
	entry.count++
	loginAttempts.byIP[ip] = entry
	return true
}

func clearLoginAttempts(ip string) {
	loginAttempts.Lock()
	delete(loginAttempts.byIP, ip)
	loginAttempts.Unlock()
}

func clientIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-Real-IP")); forwarded != "" {
		return forwarded
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func makeSessionToken(expiry time.Time) string {
	value := fmt.Sprint(expiry.Unix())
	mac := hmac.New(sha256.New, []byte(os.Getenv("SESSION_SECRET")))
	_, _ = mac.Write([]byte(value))
	return value + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *API) hasAdminSession(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return false
	}
	var expires int64
	if _, err := fmt.Sscan(parts[0], &expires); err != nil || time.Now().Unix() >= expires {
		return false
	}
	want := makeSessionToken(time.Unix(expires, 0))
	return hmac.Equal([]byte(cookie.Value), []byte(want))
}

func setSessionCookie(w http.ResponseWriter, value string) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: value, Path: "/api", HttpOnly: true, Secure: secureCookies(),
		SameSite: http.SameSiteStrictMode, Expires: time.Now().Add(sessionDuration), MaxAge: int(sessionDuration.Seconds()),
	})
}

func secureCookies() bool {
	return strings.EqualFold(os.Getenv("COOKIE_SECURE"), "true")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
