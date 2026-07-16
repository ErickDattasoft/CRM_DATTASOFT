// Funciones puras compartidas por el CRM: no leen variables globales del CRM (tickets,
// clientes, configTickets...), no tocan el DOM ni llaman a Firebase — solo reciben datos y
// devuelven un resultado calculado a partir de ellos. Primer módulo extraído de index.astro
// como parte del refactor incremental (ver plan en la rama refactor/modularizar).

// Permite ingresar varios correos separados por coma en "Correo de Soporte".
export function parseEmailList(str) {
  return (str || "")
    .split(/[,;]/)
    .map(e => e.trim())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

// "new Date().toISOString()" da la fecha en UTC — en México (UTC-6), cualquier hora después
// de las 18:00 ya cayó en el día siguiente en UTC, así que usarlo para "hoy" hace que un
// formulario abierto en la noche precargue la fecha de mañana. hoyLocalStr() calcula el
// día calendario correcto según la zona horaria del navegador.
export function hoyLocalStr() {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offsetMs).toISOString().split("T")[0];
}

// Un string "YYYY-MM-DD" (sin hora) se interpreta como medianoche UTC por el motor de JS —
// convertirlo de vuelta a fecha local puede mover el día mostrado. Forzar T00:00:00 hace
// que se interprete en la zona horaria local, evitando el corrimiento. Los timestamps
// completos (con hora/zona, ej. los de actividad de tickets) no necesitan este ajuste.
export function parseFechaLocal(fecha) {
  if (typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) return new Date(fecha + "T00:00:00");
  return new Date(fecha);
}

// Ningún dato de usuario (nombres, asuntos, descripciones, correos...) se escapaba antes de
// insertarse con innerHTML — cualquier ticket, contacto o registro público con un nombre tipo
// <img src=x onerror=...> ejecutaba ese script en la sesión de quien lo viera después.
export function escapeHtml(s) {
  return (s === null || s === undefined) ? "" : String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Los nombres de estado/prioridad de tickets son texto libre editable en Configuración.
// Antes se armaba la clase CSS con solo .toLowerCase() — un estado como "En Revisión" o
// "Espera Cliente" generaba "badge-en revisión" (espacio = dos clases distintas, ninguna
// definida) y el badge se quedaba sin color/estilo. slugBadge() normaliza a algo válido
// como clase CSS; para los estados por defecto (Abierto, Pendiente, etc.) el resultado es
// idéntico al de antes, así que no cambia nada de lo que ya funcionaba.
export function slugBadge(texto) {
  return (texto || "")
    .toString()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Los tickets de Consultoría (Sitio/Remoto) se cobran por hora — son los únicos donde el
// tiempo trabajado se marca como facturable; el resto solo lo muestra como referencia.
export function esConsultoria(tipo) {
  return tipo === "Consultoría Sitio" || tipo === "Consultoría Remoto";
}

export function formatearDuracion(totalSegundos) {
  const seg = Math.max(0, Math.round(totalSegundos));
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
  const partes = [];
  if (h) partes.push(`${h}h`);
  if (h || m) partes.push(`${m}m`);
  partes.push(`${s}s`);
  return partes.join(" ");
}

// Color del punto de la línea de tiempo del ticket — reutiliza los mismos tonos que los badges
// de estado (badge-abierto/pendiente/resuelto/cerrado) para que se vea consistente. Un estado
// personalizado que el equipo haya agregado en Configuración cae al morado por defecto.
export function colorPuntoEstado(estado) {
  const mapa = { abierto: "#38bdf8", pendiente: "#fbbf24", resuelto: "#34d399", cerrado: "#94a3b8" };
  return mapa[slugBadge(estado)] || "#a5b4fc";
}

export function formatMoney(n) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(n) || 0);
}
