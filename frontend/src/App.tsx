import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Building2,
  Check,
  ChevronDown,
  Clock3,
  CloudSun,
  DoorOpen,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  Save,
  Settings2,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react";

const days = [
  { key: "mon", short: "Пн", kkShort: "Дс", full: "Понедельник", kkFull: "Дүйсенбі" },
  { key: "tue", short: "Вт", kkShort: "Сс", full: "Вторник", kkFull: "Сейсенбі" },
  { key: "wed", short: "Ср", kkShort: "Ср", full: "Среда", kkFull: "Сәрсенбі" },
  { key: "thu", short: "Чт", kkShort: "Бс", full: "Четверг", kkFull: "Бейсенбі" },
  { key: "fri", short: "Пт", kkShort: "Жм", full: "Пятница", kkFull: "Жұма" },
  { key: "sat", short: "Сб", kkShort: "Сб", full: "Суббота", kkFull: "Сенбі" },
  { key: "sun", short: "Вс", kkShort: "Жс", full: "Воскресенье", kkFull: "Жексенбі" },
] as const;

type DayKey = (typeof days)[number]["key"];
type Schedule = Record<DayKey, string>;
type Doctor = { id: string; specialization: string; fullName: string; room: string; schedule: Schedule };
type Room = { id: string; number: string; name: string; floor: string };
type Board = {
  clinic: { name: string; address: string; city: string; timezone: string };
  doctors: Doctor[];
  rooms: Room[];
};
type Weather = { temperature: number; description: string; descriptionKk: string; code: number };

const blankSchedule = (): Schedule => ({ mon: "", tue: "", wed: "", thu: "", fri: "", sat: "", sun: "" });
const initialBoard: Board = {
  clinic: { name: "DAMED-2020", address: "", city: "Алматы", timezone: "Asia/Almaty" },
  doctors: [],
  rooms: [],
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? "Не удалось выполнить запрос.");
  return body as T;
}

function dayInZone(date: Date, timezone: string): DayKey {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: safeTimezone(timezone) }).format(date).toLowerCase();
  return (day.slice(0, 3) in { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1 } ? day.slice(0, 3) : "mon") as DayKey;
}

function safeTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value });
    return value;
  } catch {
    return "Asia/Almaty";
  }
}

function weatherDescription(code: number) {
  if (code === 0) return "Ясно";
  if (code <= 3) return "Переменная облачность";
  if (code <= 48) return "Туман";
  if (code <= 57) return "Морось";
  if (code <= 67) return "Дождь";
  if (code <= 77) return "Снег";
  if (code <= 82) return "Ливень";
  if (code <= 86) return "Снегопад";
  return "Гроза";
}

function weatherDescriptionKk(code: number) {
  if (code === 0) return "Ашық";
  if (code <= 3) return "Құбылмалы бұлтты";
  if (code <= 48) return "Тұман";
  if (code <= 57) return "Сіркіреме жауын";
  if (code <= 67) return "Жаңбыр";
  if (code <= 77) return "Қар";
  if (code <= 82) return "Нөсер";
  if (code <= 86) return "Қар жауады";
  return "Найзағай";
}

function kazakhSpecialty(value: string) {
  const translations: Record<string, string> = {
    "Врач ультразвуковой диагностики": "Ультрадыбыстық диагностика дәрігері",
    "Врач-рентгенолог": "Рентгенолог",
    Гастроэнтеролог: "Гастроэнтеролог",
    Кардиолог: "Кардиолог",
    "Врач-офтальмолог": "Көз дәрігері",
    Нефролог: "Нефролог",
    Эндокринолог: "Эндокринолог",
    Терапевт: "Жалпы практика дәрігері",
  };
  return translations[value.trim()] ?? "Мамандық";
}

function kazakhRoomName(value: string) {
  const translations: Record<string, string> = {
    "Гастроэнтеролог / Кардиолог": "Гастроэнтерология және кардиология кабинеттері",
    "Врач УЗИ": "УДЗ дәрігері",
    Офтальмолог: "Көз дәрігері",
    "Кардиолог / Нефролог": "Кардиология және нефрология кабинеттері",
    "Эндокринолог / Терапевт": "Эндокринолог / жалпы практика дәрігері",
  };
  if (translations[value]) return translations[value];
  const translated = value.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (translated) return translated[2];
  return value;
}

function kazakhFloor(value: string) {
  const translations: Record<string, string> = {
    "1 этаж": "1 ҚАБАТ",
    "Цокольный этаж": "ЖЕРТӨЛЕ ҚАБАТЫ",
  };
  return translations[value] ?? "ҚАБАТ";
}

function kazakhAddress(value: string) {
  if (!value) return "Мекенжай көрсетілмеген";
  if (value.trim().toLowerCase() === "ул. макатаева, 141/77") return "Мақатаев көшесі, 141/77";
  return value.replace(/^ул\.\s*/i, "көшесі ");
}

function App() {
  const [board, setBoard] = useState<Board>(initialBoard);
  const [boardLoaded, setBoardLoaded] = useState(false);
  const [now, setNow] = useState(new Date());
  const [weather, setWeather] = useState<Weather | null>(null);
  const [boardError, setBoardError] = useState("");
  const [doctorPage, setDoctorPage] = useState(0);
  const doctorsPerPage = 7;
  const doctorPageCount = Math.max(1, Math.ceil(board.doctors.length / doctorsPerPage));
  const activeDoctorPage = Math.min(doctorPage, doctorPageCount - 1);
  const doctorPageStart = activeDoctorPage * doctorsPerPage;
  const visibleDoctors = board.doctors.slice(doctorPageStart, doctorPageStart + doctorsPerPage);

  useEffect(() => {
    setDoctorPage(0);
    if (doctorPageCount <= 1) return;
    const timer = window.setInterval(() => {
      setDoctorPage((page) => (page + 1) % doctorPageCount);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [doctorPageCount]);

  const loadBoard = useCallback(async () => {
    try {
      const response = await api<{ board: Board }>('/api/board', { method: "GET", headers: {} });
      setBoard(response.board);
      setBoardLoaded(true);
      setBoardError("");
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : "Нет связи с сервером.");
    }
  }, []);

  useEffect(() => {
    void loadBoard();
    const refresh = window.setInterval(() => void loadBoard(), 30_000);
    const clock = window.setInterval(() => setNow(new Date()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
    };
  }, [loadBoard]);

  useEffect(() => {
    let active = true;
    const loadWeather = async () => {
      const city = board.clinic.city.trim();
      if (!city) {
        setWeather(null);
        return;
      }
      try {
        const lookup = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`);
        const place = (await lookup.json()).results?.[0];
        if (!place) throw new Error("Город не найден");
        const result = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code&timezone=${encodeURIComponent(board.clinic.timezone || "auto")}`);
        const data = await result.json();
        if (!result.ok || typeof data.current?.temperature_2m !== "number") throw new Error("Погода недоступна");
        if (active) setWeather({ temperature: Math.round(data.current.temperature_2m), code: data.current.weather_code, description: weatherDescription(data.current.weather_code), descriptionKk: weatherDescriptionKk(data.current.weather_code) });
      } catch {
        if (active) setWeather(null);
      }
    };
    void loadWeather();
    const timer = window.setInterval(() => void loadWeather(), 15 * 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [board.clinic.city, board.clinic.timezone]);

  const timezone = safeTimezone(board.clinic.timezone);
  const today = dayInZone(now, timezone);
  const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(now);
  const date = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: timezone }).format(now);
  const address = board.clinic.address || "ул. Макатаева, 141/77";
  const roomGroups = useMemo(() => {
    const groups = new Map<string, Room[]>();
    for (const room of board.rooms) {
      const group = groups.get(room.floor) ?? [];
      group.push(room);
      groups.set(room.floor, group);
    }
    return [...groups.entries()];
  }, [board.rooms]);

  const saveBoard = async (nextBoard: Board) => {
    await api("/api/board", { method: "PUT", body: JSON.stringify({ board: nextBoard }) });
    setBoard(nextBoard);
    setBoardError("");
  };

  if (window.location.pathname.replace(/\/+$/, "") === "/login") {
    if (!boardLoaded) return <main className="admin-page"><div className="admin-loading">{boardError ? <><span>{boardError}</span><button className="primary-button" onClick={() => void loadBoard()}>Попробовать ещё раз</button></> : "Загружаем расписание…"}</div></main>;
    return <AdminPanel board={board} onSave={saveBoard} />;
  }

  return (
    <main className="screen">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span>+</span></div>
          <div className="brand-copy"><strong>{board.clinic.name || "Клиника"}</strong><span>КЛИНИКА / ЕМХАНА</span></div>
        </div>
        <div className="title-block"><h1>Расписание приёма врачей</h1><span>Дәрігерлердің қабылдау кестесі</span></div>
        <div className="header-info">
          <div className="location-info"><MapPin size={23} strokeWidth={2.6} /><div><strong>{board.clinic.city || "Алматы"} / {board.clinic.city || "Алматы"} қ.</strong><span>{address}<br />{kazakhAddress(address)}</span></div></div>
          <div className="weather-info"><CloudSun size={26} strokeWidth={2.3} /><div><strong>{weather ? `${weather.temperature > 0 ? "+" : ""}${weather.temperature}°` : "—"}</strong><span>{weather?.description ?? "Погода"}<br />{weather?.descriptionKk ?? "Ауа райы"}</span></div></div>
          <div className="clock-info"><Clock3 size={24} strokeWidth={2.3} /><div><strong>{time}</strong><span>{date}</span></div></div>
        </div>
      </header>

      <section className="board-layout">
        <div className="schedule-panel">
          <div className="panel-heading"><div><span className="eyebrow">РАСПИСАНИЕ / ҚАБЫЛДАУ КЕСТЕСІ</span><h2>Врачи и время приёма / Дәрігерлер мен қабылдау уақыты</h2></div><span className="today-pill"><span className="live-dot" /><span>{days.find((day) => day.key === today)?.full}</span><small>{days.find((day) => day.key === today)?.kkFull}</small></span></div>
          {boardError && <div className="connection-banner">{boardError}</div>}
          <div className="table-frame">
            <table className="schedule-table">
              <thead><tr>
                <th className="specialty-col"><span>Специализация</span><small>Мамандық</small></th>
                <th className="doctor-col"><span>Врач</span><small>Дәрігер</small></th>
                <th className="room-col"><span>Каб.</span><small>Кабинет</small></th>
                {days.map((day) => <th className={day.key === today ? "today-column" : ""} key={day.key}><span>{day.short}</span><small>{day.kkShort}</small></th>)}
              </tr></thead>
              <tbody>
                {board.doctors.length ? visibleDoctors.map((doctor) => <tr key={doctor.id}>
                  <td className="specialty-cell"><span>{doctor.specialization || "—"}</span><small>{kazakhSpecialty(doctor.specialization)}</small></td><td className="doctor-cell" title={doctor.fullName}>{doctor.fullName || "—"}</td><td className="room-cell">{doctor.room || "—"}</td>
                  {days.map((day) => <td className={`hours-cell ${day.key === today ? "today-column" : ""}`} key={day.key}>{doctor.schedule?.[day.key] || <span className="off-mark">—</span>}</td>)}
                </tr>) : <tr className="empty-row"><td colSpan={10}><div className="empty-state"><span className="empty-icon"><Stethoscope size={28} /></span><strong>Расписание пока не заполнено</strong><span>Добавьте врачей через админ-панель</span></div></td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="board-footer"><span><span className="footer-dot" /><span>Расписание обновляется автоматически<small>Кесте автоматты түрде жаңартылады</small></span></span>{doctorPageCount > 1 && <span className="doctor-page-indicator" aria-live="polite"><strong>Врачи / Дәрігерлер {doctorPageStart + 1}–{Math.min(doctorPageStart + doctorsPerPage, board.doctors.length)} / {board.doctors.length}</strong><small>Смена / ауысу · 15 сек</small></span>}<span>Для уточнения времени обратитесь в регистратуру<small>Уақытты нақтылау үшін тіркеу бөліміне хабарласыңыз</small></span></footer>
        </div>

        <aside className="rooms-panel">
          <div className="rooms-title"><Building2 size={29} /><div><span className="eyebrow">НАВИГАЦИЯ / БАҒЫТТАМА</span><h2>Этажи и кабинеты</h2><small>Қабаттар мен кабинеттер</small></div></div>
          <div className="rooms-scroll">
            {roomGroups.length ? roomGroups.map(([floor, rooms]) => <section className="floor-group" key={floor}>
              <h3><span>{floor || "Этаж"}</span><small>{kazakhFloor(floor)}</small></h3>
              <ul>{rooms.map((room) => <li key={room.id}><strong>{room.number}</strong><span className="room-separator">—</span><span className="room-name"><span>{room.name.match(/^(.*?)\s*\((.*?)\)\s*$/)?.[1] ?? room.name}</span><small>{kazakhRoomName(room.name)}</small></span></li>)}</ul>
            </section>) : <div className="rooms-empty"><DoorOpen size={26} /><span>Кабинеты появятся здесь</span><small>Добавьте их в админ-панели</small></div>}
          </div>
          <div className="rooms-bottom"><span className="floor-mark"><Building2 size={15} /></span><span>Поможем найти нужный кабинет<small>Қажетті кабинетті табуға көмектесеміз</small></span></div>
        </aside>
      </section>
    </main>
  );
}

function AdminPanel({ board, onSave }: { board: Board; onSave: (board: Board) => Promise<void> }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Board>(structuredClone(board));
  const [section, setSection] = useState<"doctors" | "rooms" | "clinic">("doctors");
  const [doctorEditor, setDoctorEditor] = useState<Doctor | "new" | null>(null);
  const [roomEditor, setRoomEditor] = useState<Room | "new" | null>(null);

  useEffect(() => {
    api<{ authenticated: boolean }>("/api/session").then((result) => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false));
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setLoginError("");
    try {
      await api("/api/session", { method: "POST", body: JSON.stringify({ password }) });
      setAuthenticated(true);
      setPassword("");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Не удалось войти.");
    }
  };

  const submit = async () => {
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      await onSave(draft);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не удалось сохранить расписание.");
    } finally {
      setSaving(false);
    }
  };

  const logout = async () => {
    try { await api("/api/session", { method: "DELETE" }); } catch { /* Closing the panel still ends this session in the UI. */ }
    setAuthenticated(false);
  };

  const updateDoctor = (doctor: Doctor) => {
    setDraft((current) => ({ ...current, doctors: current.doctors.some((item) => item.id === doctor.id) ? current.doctors.map((item) => item.id === doctor.id ? doctor : item) : [...current.doctors, doctor] }));
    setDoctorEditor(null);
  };

  const updateRoom = (room: Room) => {
    setDraft((current) => ({ ...current, rooms: current.rooms.some((item) => item.id === room.id) ? current.rooms.map((item) => item.id === room.id ? room : item) : [...current.rooms, room] }));
    setRoomEditor(null);
  };

  return <main className="admin-page">
    <section className="admin-panel" aria-labelledby="admin-title">
      <header className="admin-header"><div><span className="admin-kicker">УПРАВЛЕНИЕ ТАБЛОМ / ТАҚТАНЫ БАСҚАРУ</span><h2 id="admin-title">Админ-панель</h2></div><a className="admin-return" href="/"><ArrowLeft size={17} />На расписание</a></header>
      {authenticated === null ? <div className="admin-loading">Проверяем вход…</div> : !authenticated ? <form className="login-card" onSubmit={login}>
        <span className="login-icon"><Settings2 size={25} /></span><h3>Вход администратора / Әкімшіге кіру</h3><p>Введите пароль, чтобы изменить расписание и список кабинетов.<br />Кесте мен кабинеттерді өзгерту үшін құпиясөзді енгізіңіз.</p>
        <label className="field-label" htmlFor="admin-password">Пароль</label><input id="admin-password" className="text-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        {loginError && <div className="form-error">{loginError}</div>}<button className="primary-button full-button" type="submit">Войти <ChevronDown className="login-arrow" size={18} /></button>
      </form> : <>
        <nav className="admin-tabs" aria-label="Разделы админ-панели">
          <button className={section === "doctors" ? "active" : ""} onClick={() => setSection("doctors")}><Stethoscope size={17} />Врачи</button>
          <button className={section === "rooms" ? "active" : ""} onClick={() => setSection("rooms")}><DoorOpen size={17} />Кабинеты</button>
          <button className={section === "clinic" ? "active" : ""} onClick={() => setSection("clinic")}><Building2 size={17} />Клиника</button>
        </nav>
        <div className="admin-content">
          {section === "doctors" && <section className="admin-section"><div className="section-title-row"><div><h3>Расписание врачей</h3><p>{draft.doctors.length} {draft.doctors.length === 1 ? "врач" : "врачей"}</p></div><button className="primary-button compact-button" onClick={() => setDoctorEditor("new")}><Plus size={17} />Добавить врача</button></div>
            {draft.doctors.length ? <div className="admin-list">{draft.doctors.map((doctor) => <article className="admin-list-row" key={doctor.id}><div className="avatar-small"><Stethoscope size={18} /></div><div className="list-main"><strong>{doctor.fullName}</strong><span>{doctor.specialization} · каб. {doctor.room || "—"}</span></div><button className="subtle-icon" onClick={() => setDoctorEditor(doctor)} aria-label={`Изменить: ${doctor.fullName}`}><Pencil size={17} /></button><button className="subtle-icon danger-icon" onClick={() => setDraft((current) => ({ ...current, doctors: current.doctors.filter((item) => item.id !== doctor.id) }))} aria-label={`Удалить: ${doctor.fullName}`}><Trash2 size={17} /></button></article>)}</div> : <div className="admin-empty"><Stethoscope size={24} /><strong>Список пока пуст</strong><span>Добавьте первого врача и укажите время приёма.</span></div>}
          </section>}
          {section === "rooms" && <section className="admin-section"><div className="section-title-row"><div><h3>Кабинеты и этажи</h3><p>{draft.rooms.length} {draft.rooms.length === 1 ? "кабинет" : "кабинетов"}</p></div><button className="primary-button compact-button" onClick={() => setRoomEditor("new")}><Plus size={17} />Добавить кабинет</button></div>
            {draft.rooms.length ? <div className="admin-list">{draft.rooms.map((room) => <article className="admin-list-row" key={room.id}><div className="room-number-small">{room.number || "—"}</div><div className="list-main"><strong>{room.name}</strong><span>{room.floor || "Этаж не указан"}</span></div><button className="subtle-icon" onClick={() => setRoomEditor(room)} aria-label={`Изменить кабинет ${room.number}`}><Pencil size={17} /></button><button className="subtle-icon danger-icon" onClick={() => setDraft((current) => ({ ...current, rooms: current.rooms.filter((item) => item.id !== room.id) }))} aria-label={`Удалить кабинет ${room.number}`}><Trash2 size={17} /></button></article>)}</div> : <div className="admin-empty"><DoorOpen size={24} /><strong>Кабинеты ещё не добавлены</strong><span>Добавьте номера кабинетов, этажи и их назначение.</span></div>}
          </section>}
          {section === "clinic" && <section className="admin-section clinic-form"><div className="section-title-row"><div><h3>Данные клиники</h3><p>Название, адрес и часовой пояс на табло</p></div></div>
            <label>Название клиники<input className="text-input" value={draft.clinic.name} onChange={(event) => setDraft((current) => ({ ...current, clinic: { ...current.clinic, name: event.target.value } }))} /></label>
            <label>Адрес<input className="text-input" value={draft.clinic.address} onChange={(event) => setDraft((current) => ({ ...current, clinic: { ...current.clinic, address: event.target.value } }))} /></label>
            <label>Город — для погоды<input className="text-input" value={draft.clinic.city} onChange={(event) => setDraft((current) => ({ ...current, clinic: { ...current.clinic, city: event.target.value } }))} /></label>
            <label>Часовой пояс<input className="text-input" value={draft.clinic.timezone} onChange={(event) => setDraft((current) => ({ ...current, clinic: { ...current.clinic, timezone: event.target.value } }))} placeholder="Asia/Almaty" /></label>
          </section>}
        </div>
        <footer className="admin-footer"><div className="save-status">{saveError ? <span className="form-error">{saveError}</span> : saved ? <span className="save-success"><Check size={16} />Изменения сохранены</span> : <span>Изменения увидят все экраны</span>}</div><div className="footer-actions"><button className="text-button" onClick={logout}><LogOut size={16} />Выйти</button><button className="primary-button" onClick={() => void submit()} disabled={saving}><Save size={17} />{saving ? "Сохраняем…" : "Сохранить"}</button></div></footer>
      </>}
      {doctorEditor && <DoctorEditor value={doctorEditor === "new" ? null : doctorEditor} rooms={draft.rooms} onCancel={() => setDoctorEditor(null)} onSave={updateDoctor} />}
      {roomEditor && <RoomEditor value={roomEditor === "new" ? null : roomEditor} onCancel={() => setRoomEditor(null)} onSave={updateRoom} />}
    </section>
  </main>;
}

function DoctorEditor({ value, rooms, onCancel, onSave }: { value: Doctor | null; rooms: Room[]; onCancel: () => void; onSave: (doctor: Doctor) => void }) {
  const [specialization, setSpecialization] = useState(value?.specialization ?? "");
  const [fullName, setFullName] = useState(value?.fullName ?? "");
  const [room, setRoom] = useState(value?.room ?? "");
  const [schedule, setSchedule] = useState<Schedule>(value?.schedule ?? blankSchedule());
  const [error, setError] = useState("");

  const setDayActive = (key: DayKey, active: boolean) => setSchedule((current) => ({ ...current, [key]: active ? "08:00–17:00" : "" }));
  const setDayTime = (key: DayKey, side: "start" | "end", time: string) => setSchedule((current) => {
    const [start = "", end = ""] = current[key].split(/[–-]/);
    return { ...current, [key]: `${side === "start" ? time : start}–${side === "end" ? time : end}` };
  });
  const splitTime = (value: string) => {
    const match = value.match(/^(\d{2}:\d{2})[–-](\d{2}:\d{2})$/);
    return match ? [match[1], match[2]] : ["", ""];
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!specialization.trim() || !fullName.trim()) return setError("Укажите специализацию и ФИО врача.");
    if (days.some((day) => schedule[day.key] && !/^\d{2}:\d{2}[–-]\d{2}:\d{2}$/.test(schedule[day.key]))) return setError("Укажите время начала и окончания смены.");
    onSave({ id: value?.id ?? crypto.randomUUID(), specialization: specialization.trim(), fullName: fullName.trim(), room, schedule });
  };

  return <div className="editor-backdrop"><form className="editor-card doctor-editor" onSubmit={submit}><div className="editor-heading"><div><span className="admin-kicker">КАРТОЧКА ВРАЧА</span><h3>{value ? "Изменить врача" : "Новый врач"}</h3></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Закрыть"><X /></button></div>
    <div className="editor-fields"><label>Специализация<input className="text-input" autoFocus value={specialization} onChange={(event) => setSpecialization(event.target.value)} placeholder="Например, терапевт" /></label><label>ФИО врача<input className="text-input" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Фамилия Имя Отчество" /></label><label>Кабинет<input className="text-input" list="doctor-room-list" value={room} onChange={(event) => setRoom(event.target.value)} placeholder="Например, 201" /><datalist id="doctor-room-list">{rooms.map((item) => <option value={item.number} key={item.id}>{item.name}</option>)}</datalist></label></div>
    <div className="schedule-editor"><div className="schedule-editor-head"><strong>Время приёма</strong><span>Отметьте рабочие дни</span></div>{days.map((day) => { const enabled = Boolean(schedule[day.key]); const [start, end] = splitTime(schedule[day.key]); return <div className={`day-editor ${enabled ? "enabled" : ""}`} key={day.key}><label className="day-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setDayActive(day.key, event.target.checked)} /><span>{day.short}</span></label>{enabled ? <><label><span className="sr-only">Начало, {day.full}</span><input type="time" value={start} required onChange={(event) => setDayTime(day.key, "start", event.target.value)} /></label><span className="time-dash">—</span><label><span className="sr-only">Окончание, {day.full}</span><input type="time" value={end} required onChange={(event) => setDayTime(day.key, "end", event.target.value)} /></label></> : <span className="day-off">Выходной</span>}</div>; })}</div>
    {error && <div className="form-error">{error}</div>}<div className="editor-actions"><button type="button" className="text-button" onClick={onCancel}>Отмена</button><button className="primary-button" type="submit"><Check size={16} />Готово</button></div>
  </form></div>;
}

function RoomEditor({ value, onCancel, onSave }: { value: Room | null; onCancel: () => void; onSave: (room: Room) => void }) {
  const [number, setNumber] = useState(value?.number ?? "");
  const [name, setName] = useState(value?.name ?? "");
  const [floor, setFloor] = useState(value?.floor ?? "");
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!number.trim() || !name.trim() || !floor.trim()) return setError("Заполните номер, название и этаж кабинета.");
    onSave({ id: value?.id ?? crypto.randomUUID(), number: number.trim(), name: name.trim(), floor: floor.trim() });
  };
  return <div className="editor-backdrop"><form className="editor-card room-editor" onSubmit={submit}><div className="editor-heading"><div><span className="admin-kicker">КАБИНЕТ</span><h3>{value ? "Изменить кабинет" : "Новый кабинет"}</h3></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Закрыть"><X /></button></div>
    <div className="editor-fields"><label>Номер<input className="text-input" autoFocus value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Например, 201" /></label><label>Назначение<input className="text-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, терапевт" /></label><label>Этаж<input className="text-input" value={floor} onChange={(event) => setFloor(event.target.value)} placeholder="Например, 2 этаж" /></label></div>
    {error && <div className="form-error">{error}</div>}<div className="editor-actions"><button type="button" className="text-button" onClick={onCancel}>Отмена</button><button className="primary-button" type="submit"><Check size={16} />Готово</button></div>
  </form></div>;
}

export default App;
