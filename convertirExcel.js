import XLSX from "xlsx";
import fs from "fs";

const file = fs.readFileSync("src/data/Plantilla_Agenda_Astro.xlsx");
const workbook = XLSX.read(file, { type: "buffer" });

function sheetDataByName(names) {
	for (const name of names) {
		const idx = workbook.SheetNames.findIndex(s => s.toLowerCase().includes(name.toLowerCase()));
		if (idx >= 0) return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[idx]]);
	}
	// fallback to first sheet
	return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
}

const clientesData = sheetDataByName(["empresas", "clientes"]);
const contactosData = sheetDataByName(["contactos", "contactos empresas", "contacts"]);

fs.writeFileSync("src/data/clientes.json", JSON.stringify(clientesData, null, 2));
fs.writeFileSync("src/data/contactos.json", JSON.stringify(contactosData, null, 2));

console.log("Excel convertido a JSON correctamente: clientes.json y contactos.json generados");