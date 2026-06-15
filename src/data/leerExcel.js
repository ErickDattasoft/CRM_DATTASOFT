import * as XLSX from "xlsx";
import fs from "fs";

export function obtenerDatos() {
  const file = fs.readFileSync("src/data/Plantilla_Agenda_Astro.xlsx");
  const workbook = XLSX.read(file, { type: "buffer" });

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  return data;
}