import * as XLSX from "xlsx";
import fs from "fs";

const workbook = XLSX.readFile("src/data/Plantilla_Agenda_Astro.xlsx");
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet);

fs.writeFileSync("src/data/clientes.json", JSON.stringify(data, null, 2));

console.log("Excel convertido a JSON correctamente");