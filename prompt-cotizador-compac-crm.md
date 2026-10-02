# Especificación: Cotizador de sistemas Compac para CRM

## Contexto
Se requiere un módulo/calculadora dentro del CRM que genere cotizaciones de licenciamiento de software Compac (Contabilidad, Bancos, Nóminas, Comercial Premium, Comercial Pro, XML en línea, Factura Electrónica, SQL), aplicando reglas de precio por equipo.

## Catálogo de sistemas

| Sistema | ¿Requiere "Componentes"? |
|---|---|
| Contabilidad | Sí |
| Bancos | Sí |
| Nóminas | Sí |
| Comercial Premium | Sí |
| XML en línea | Sí |
| Factura Electrónica | No |
| Comercial Pro | No |
| SQL | No aplica (ver regla especial) |

"Componentes" no se selecciona manualmente: se agrega automáticamente a un equipo cuando ese equipo tiene marcado al menos uno de los sistemas que lo requieren (columna anterior = "Sí"). Cuando se agrega, cuenta como un sistema más para efectos de precio (igual que Nóminas o cualquier otro).

## Tipos de equipo y precios base (parametrizables)

| Tipo de equipo | 1er sistema | Cada sistema adicional |
|---|---|---|
| Servidor | $800 | $400 |
| Terminal | $200 | $100 |

Regla de precio por equipo:
```
precio_equipo = precio_1er_sistema + (num_sistemas - 1) * precio_adicional
```
donde `num_sistemas` incluye "Componentes" si fue disparado automáticamente.

## Regla especial: SQL

- Solo aplica a equipos tipo Servidor.
- Precio fijo: $800 (parametrizable).
- Es un cargo aparte: NO participa en el conteo de "1er sistema / adicional", y NO dispara "Componentes".
- Se suma como línea independiente al subtotal del equipo/servidor.

## Modelo de datos de entrada

La cotización se arma por **grupos de equipos**: conjuntos de equipos idénticos en tipo y en la combinación de sistemas instalados. Un cliente puede tener varios grupos de terminales distintos (ej. 4 terminales con 4 sistemas, 3 terminales con 2 sistemas, 3 terminales con 1 sistema).

Cada grupo captura:
- `tipo`: "Servidor" | "Terminal"
- `cantidad`: número de equipos idénticos en este grupo
- `sistemas`: lista de sistemas seleccionados (de la tabla anterior)
- `incluye_sql`: booleano (solo válido si tipo = "Servidor")

## Lógica de cálculo (por grupo)

1. Tomar `sistemas` seleccionados.
2. Si alguno de esos sistemas está marcado como "requiere Componentes" en el catálogo, añadir "Componentes" a la lista de sistemas del grupo (una sola vez, sin duplicar).
3. `num_sistemas = length(sistemas)` (después de añadir Componentes si aplica).
4. Si `num_sistemas > 0`:
   `precio_sistemas_por_unidad = precio_1er_sistema[tipo] + (num_sistemas - 1) * precio_adicional[tipo]`
   Si `num_sistemas == 0`, `precio_sistemas_por_unidad = 0`.
5. `precio_sql_por_unidad = incluye_sql ? precio_sql : 0` (solo posible si tipo = "Servidor").
6. `precio_por_unidad = precio_sistemas_por_unidad + precio_sql_por_unidad`.
7. `subtotal_grupo = precio_por_unidad * cantidad`.

## Total de la cotización

```
total = suma(subtotal_grupo) para todos los grupos
```

## Validaciones / utilidades esperadas en el CRM

- Permitir capturar, de forma opcional, el total de servidores y el total de terminales que el cliente tiene en su parque de equipos, para comparar contra la suma de `cantidad` ya capturada en los grupos y alertar si no coincide (equipo faltante por cotizar).
- Mostrar un contador de cuántos equipos en total llevan "Componentes" incluido (suma de `cantidad` de los grupos donde se disparó Componentes), separado del resto, para que quede visible cuántos equipos están pagando por ese componente compartido.
- Los precios base (1er sistema / adicional por tipo de equipo, y precio de SQL) deben ser editables, no hardcodeados, porque pueden cambiar con el tiempo.
- Un equipo puede tener 1, 2, 3 o más sistemas simultáneamente; el sistema debe soportar cualquier combinación, no solo las predefinidas.

## Salida esperada de la cotización

Por cada grupo: tipo de equipo, cantidad, lista de sistemas (indicando cuáles se agregaron automáticamente por regla, ej. "Componentes (auto)"), precio unitario, subtotal.
Al final: gran total y el resumen de conteos (servidores, terminales, equipos con Componentes) para validación.

## Nota de implementación
Esta lógica ya existe funcionando como prototipo en HTML/JS independiente. Al integrarla al CRM, se debe:
1. Adaptar el modelo de datos anterior a los objetos/campos nativos del CRM (ej. como un "producto" o "line item" calculado dentro de una cotización/oportunidad).
2. Reimplementar la función de cálculo del apartado "Lógica de cálculo" en el lenguaje de scripting/automatización del CRM (ej. Deluge en Zoho, custom code workflows en HubSpot, Apex/Flow en Salesforce), o como llamada a un endpoint externo si el CRM lo permite.
3. Mantener editable el catálogo de precios y la tabla de "qué sistema dispara Componentes", para no tener que tocar código cuando cambien tarifas.
