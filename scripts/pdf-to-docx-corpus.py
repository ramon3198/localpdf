"""Ground-truth corpus for the PDF -> Word converter (checked by scripts/pdf-to-docx-check.mjs).

Builds Word documents with python-docx that exercise what the converter has to reproduce (headings, alignment, run
styles, lists, tables with merged cells, images, columns, headers/footers with page numbers, a letter, superscripts,
links, long text, several fonts, a landscape page, tab leaders), exports each one to PDF with Microsoft Word and
writes manifest.json. The .docx files are the ground truth, the PDFs are the converter's input.

  python scripts/pdf-to-docx-corpus.py --out <dir> [--image banner.png --image photo.png]
         [--word-export <word-export.ps1>] [--only <regex>] [--force]

  --image         PNGs used by the image documents (a generated test pattern when omitted)
  --word-export   PowerShell script that exports a .docx to PDF with Word (-In/-Out); without it only the .docx
                  files are built. Existing PDFs newer than their .docx are kept unless --force.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import zlib
import struct

from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Inches, Pt, RGBColor

A4 = (Cm(21), Cm(29.7))
LETTER = (Inches(8.5), Inches(11))

# ── Spanish text pool (every paragraph is unique so reading-order anchors stay unambiguous) ──────────────────────

POOL = [
    "La empresa cerró el tercer trimestre con una facturación de 4,2 millones de euros, lo que supone un crecimiento "
    "del 12 % respecto al mismo periodo del año anterior. El margen bruto se situó en el 38,5 %, impulsado por la mejora "
    "de la eficiencia en los procesos de producción y por la renegociación de los contratos con proveedores estratégicos.",
    "Durante el periodo analizado se incorporaron catorce nuevos clientes en el segmento corporativo, principalmente en "
    "Andalucía, Cataluña y la Comunidad de Madrid. La cartera de pedidos pendientes asciende a 1.850.000 €, una cifra que "
    "garantiza la actividad de la planta hasta finales del primer semestre del próximo año.",
    "El equipo de dirección considera que la estrategia de diversificación iniciada hace dos años empieza a dar sus "
    "frutos. La línea de servicios de mantenimiento, que hace apenas dieciocho meses representaba un porcentaje marginal "
    "de los ingresos, aporta ya casi una cuarta parte del beneficio operativo.",
    "No obstante, el aumento de los costes energéticos y la subida de los tipos de interés siguen presionando la cuenta "
    "de resultados. Por ello, el consejo de administración ha aprobado un plan de contención del gasto que prevé ahorros "
    "de hasta 300.000 € anuales sin afectar a la plantilla ni a la calidad del servicio.",
    "En el ámbito de la sostenibilidad, la compañía ha reducido un 18 % sus emisiones gracias a la instalación de paneles "
    "solares en la nave de Guadalajara y a la renovación de la flota de vehículos comerciales. El objetivo para el año "
    "2028 es alcanzar la neutralidad climática en todas las instalaciones propias.",
    "La señora Muñoz, responsable del área de innovación, subrayó que la digitalización de los almacenes permitirá "
    "reducir a la mitad los tiempos de preparación de pedidos. «Queremos que cada cliente reciba su mercancía en menos "
    "de veinticuatro horas», añadió durante la presentación ante los accionistas.",
    "El proyecto de rehabilitación del casco antiguo contempla la restauración de treinta y dos fachadas, la mejora de "
    "la accesibilidad en las calles peatonales y la creación de un nuevo espacio cultural en el antiguo mercado de "
    "abastos. Las obras comenzarán en otoño y se prolongarán durante aproximadamente dieciocho meses.",
    "Los vecinos podrán consultar los planos y presentar alegaciones en la oficina municipal de urbanismo, de lunes a "
    "viernes, entre las nueve de la mañana y las dos de la tarde. También se habilitará un formulario en la sede "
    "electrónica del ayuntamiento para quienes prefieran realizar el trámite por internet.",
    "¿Por qué es importante leer la letra pequeña? Porque en ella se encuentran las condiciones que determinan los "
    "derechos y las obligaciones de ambas partes. Un contrato bien redactado evita malentendidos y protege tanto al "
    "consumidor como a la empresa que presta el servicio.",
    "La biblioteca pública amplía su horario durante el periodo de exámenes: abrirá de ocho de la mañana a once de la "
    "noche, incluidos los sábados y domingos. Además, se han habilitado cuarenta puestos adicionales de estudio con "
    "conexión eléctrica y acceso gratuito a la red inalámbrica.",
    "El informe recoge también las conclusiones de la auditoría externa, que no ha detectado incidencias significativas "
    "en los estados financieros. Los auditores recomiendan, no obstante, reforzar los controles internos sobre la gestión "
    "de inventarios y documentar con mayor detalle los procedimientos de aprobación de gastos.",
    "Pequeños cambios en los hábitos diarios pueden tener un gran impacto: apagar las luces al salir de una habitación, "
    "reutilizar las bolsas de la compra o elegir el transporte público en lugar del coche privado son gestos sencillos "
    "que, sumados, contribuyen a cuidar el medio ambiente.",
    "La historia de la ciudad está ligada desde sus orígenes al río que la atraviesa. Los primeros asentamientos se "
    "levantaron en la orilla norte, donde el terreno elevado protegía a sus habitantes de las crecidas invernales. Con el "
    "paso de los siglos, los puentes de piedra unieron ambas márgenes y el comercio fluvial convirtió la villa en un "
    "próspero centro de intercambio de lana, vino y aceite.",
    "A partir del siglo XIX, la llegada del ferrocarril transformó por completo la fisonomía urbana. Se derribaron las "
    "antiguas murallas, se trazaron amplias avenidas arboladas y surgieron los primeros barrios obreros alrededor de las "
    "fábricas textiles. Muchos de aquellos edificios industriales se conservan hoy como museos o centros de empresas.",
    "El acceso a los datos personales se limitará exclusivamente al personal autorizado y se registrará en un sistema de "
    "trazabilidad que permita conocer en todo momento quién ha consultado cada expediente. Los interesados podrán ejercer "
    "sus derechos de acceso, rectificación, supresión y portabilidad dirigiéndose por escrito al delegado de protección "
    "de datos.",
    "Para garantizar la continuidad del servicio, se realizarán copias de seguridad diarias de todos los sistemas "
    "críticos, que se almacenarán cifradas en dos centros de datos ubicados en ciudades diferentes. Las pruebas de "
    "restauración se llevarán a cabo al menos una vez por trimestre y sus resultados quedarán documentados.",
    "El festival de otoño reunirá este año a más de sesenta compañías de teatro, danza y música procedentes de doce "
    "países. Las entradas, con precios desde 8 €, podrán adquirirse en taquilla o a través de la web oficial, y los "
    "menores de dieciséis años acompañados de un adulto tendrán un descuento del 50 %.",
    "La cooperativa agrícola ha comenzado la vendimia con una previsión de cosecha ligeramente inferior a la del año "
    "pasado debido a la sequía primaveral. Sin embargo, los técnicos destacan la excelente calidad de la uva, con un "
    "grado de maduración óptimo y un estado sanitario impecable en la mayoría de las parcelas.",
    "Los alumnos de segundo curso presentaron sus proyectos de fin de ciclo ante un tribunal formado por profesores y "
    "representantes de empresas del sector. Entre los trabajos más valorados figuró una aplicación que ayuda a las "
    "personas mayores a gestionar su medicación mediante recordatorios por voz.",
    "El nuevo reglamento de uso de las instalaciones deportivas establece que las reservas deberán realizarse con un "
    "máximo de siete días de antelación. Las pistas no utilizadas sin aviso previo supondrán la suspensión temporal del "
    "derecho de reserva durante un periodo de quince días naturales.",
    "Según el último estudio de la asociación de consumidores, el precio medio de la cesta de la compra ha subido un "
    "4,7 % en el último año. Los productos frescos, especialmente la fruta y el pescado, son los que más se han "
    "encarecido, mientras que los lácteos y las legumbres se mantienen estables.",
    "La restauración del retablo mayor de la iglesia parroquial ha sacado a la luz pinturas del siglo XVI ocultas bajo "
    "varias capas de repintes posteriores. Los expertos creen que podrían atribuirse al taller de un maestro flamenco "
    "que trabajó en la región durante la segunda mitad de aquel siglo.",
    "El servicio de atención al cliente estará disponible de lunes a sábado, de ocho de la mañana a diez de la noche, "
    "en el teléfono gratuito y por correo electrónico. Las consultas recibidas fuera de ese horario se responderán en "
    "un plazo máximo de veinticuatro horas laborables.",
    "La excursión al parque natural incluye el transporte en autobús, un almuerzo típico en un restaurante de la zona y "
    "la visita guiada al centro de interpretación. Se recomienda llevar calzado cómodo, protección solar y agua "
    "suficiente, ya que parte del recorrido se realiza a pie por senderos de montaña.",
    "Los resultados de la encuesta de satisfacción muestran que el 87 % de los usuarios valora positivamente la "
    "atención recibida, aunque un tercio de los encuestados considera que los tiempos de espera telefónica siguen "
    "siendo demasiado largos. La dirección se ha comprometido a reforzar el servicio en las horas punta.",
    "El ayuntamiento ha aprobado una partida de 2,3 millones de euros para renovar el alumbrado público con tecnología "
    "de bajo consumo. La actuación afectará a más de cuatro mil farolas y permitirá reducir la factura eléctrica "
    "municipal en torno a un 60 %, además de disminuir la contaminación lumínica.",
    "Para solicitar la ayuda es imprescindible estar empadronado en el municipio con una antigüedad mínima de un año y "
    "no superar los límites de renta establecidos en las bases de la convocatoria. Las solicitudes incompletas "
    "dispondrán de un plazo de diez días hábiles para su subsanación.",
    "La exposición temporal reúne más de ciento veinte fotografías que documentan la vida cotidiana en los pueblos de la "
    "comarca durante la primera mitad del siglo pasado. Muchas de las imágenes proceden de álbumes familiares cedidos "
    "de forma desinteresada por los propios vecinos.",
    "Las previsiones meteorológicas anuncian un fin de semana con temperaturas suaves y cielos despejados en casi toda "
    "la península, aunque no se descartan chubascos aislados en el norte a partir del domingo por la tarde. En las "
    "Canarias soplará viento moderado del nordeste.",
    "El programa de mentorías pone en contacto a jóvenes emprendedores con profesionales con experiencia que les "
    "asesoran de forma gratuita durante los primeros meses de actividad. En la última edición participaron noventa "
    "proyectos, de los cuales más de la mitad siguen hoy en funcionamiento.",
]


# ── python-docx helpers ────────────────────────────────────────────────────────────────────────────────────────────


def strip_theme_fonts(r_fonts):
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        r_fonts.attrib.pop(qn(attr), None)


def style_font(style, name=None, size=None, bold=None, italic=None, color=None):
    """Explicit font on a style (theme font references removed so Word really uses `name`)."""
    font = style.font
    if name:
        font.name = name
        r_fonts = style.element.rPr.find(qn("w:rFonts"))
        strip_theme_fonts(r_fonts)
        r_fonts.set(qn("w:cs"), name)
        r_fonts.set(qn("w:eastAsia"), name)
    if size:
        font.size = Pt(size)
    if bold is not None:
        font.bold = bold
    if italic is not None:
        font.italic = italic
    if color:
        font.color.rgb = RGBColor.from_string(color)


def new_doc(font, size, page=A4, margins_cm=2.5, after=8, line=1.15):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = page
    for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(sec, side, Cm(margins_cm))
    normal = doc.styles["Normal"]
    style_font(normal, font, size)
    normal.paragraph_format.space_after = Pt(after)
    normal.paragraph_format.line_spacing = line
    return doc


def headings(doc, font, sizes=(16, 13, 12), colors=("2F5496", "2F5496", "1F3763")):
    for level, (size, color) in enumerate(zip(sizes, colors), start=1):
        style = doc.styles[f"Heading {level}"]
        style_font(style, font, size, bold=level < 3, color=color)
        style.paragraph_format.space_before = Pt(12 if level == 1 else 8)
        style.paragraph_format.space_after = Pt(4)


def add_runs(par, runs):
    """runs: str or list of str / (text, props). props: b i u strike color size font sup sub."""
    if isinstance(runs, str):
        runs = [runs]
    for item in runs:
        text, props = (item, {}) if isinstance(item, str) else item
        run = par.add_run(text)
        f = run.font
        if props.get("b"):
            f.bold = True
        if props.get("i"):
            f.italic = True
        if props.get("u"):
            f.underline = True
        if props.get("strike"):
            f.strike = True
        if props.get("color"):
            f.color.rgb = RGBColor.from_string(props["color"])
        if props.get("size"):
            f.size = Pt(props["size"])
        if props.get("font"):
            f.name = props["font"]
            run._r.rPr.rFonts.set(qn("w:cs"), props["font"])
        if props.get("sup"):
            f.superscript = True
        if props.get("sub"):
            f.subscript = True
    return par


def para(doc, runs="", align=None, style=None, before=None, after=None, line=None, left=None, right=None, first=None):
    p = doc.add_paragraph(style=style)
    add_runs(p, runs)
    fmt = p.paragraph_format
    if align:
        p.alignment = {
            "left": WD_ALIGN_PARAGRAPH.LEFT,
            "center": WD_ALIGN_PARAGRAPH.CENTER,
            "right": WD_ALIGN_PARAGRAPH.RIGHT,
            "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
        }[align]
    if before is not None:
        fmt.space_before = Pt(before)
    if after is not None:
        fmt.space_after = Pt(after)
    if line is not None:
        fmt.line_spacing = line
    if left is not None:
        fmt.left_indent = Cm(left)
    if right is not None:
        fmt.right_indent = Cm(right)
    if first is not None:
        fmt.first_line_indent = Cm(first)
    return p


def heading(doc, text, level):
    return doc.add_heading(text, level)


BULLET_LEVELS = [("bullet", "\uf0b7", "Symbol"), ("bullet", "o", "Courier New"), ("bullet", "\uf0a7", "Wingdings")]
NUMBER_LEVELS = [("decimal", "%1.", None), ("lowerLetter", "%2)", None), ("lowerRoman", "%3.", None)]


def new_list(doc, kind):
    """A fresh Word list (its own w:num, so numbering restarts). Returns the numId."""
    numbering = doc.part.numbering_part.element
    abstract_ids = [int(a.get(qn("w:abstractNumId"))) for a in numbering.findall(qn("w:abstractNum"))]
    num_ids = [int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))]
    abs_id = max(abstract_ids + [0]) + 1
    num_id = max(num_ids + [0]) + 1
    levels = ""
    for ilvl, (fmt, text, font) in enumerate(BULLET_LEVELS if kind == "bullet" else NUMBER_LEVELS):
        rpr = f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:hint="default"/></w:rPr>' if font else ""
        left = 720 * (ilvl + 1)
        levels += (
            f'<w:lvl w:ilvl="{ilvl}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/>'
            f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{left}" w:hanging="360"/></w:pPr>{rpr}</w:lvl>'
        )
    abstract = parse_xml(
        f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{abs_id}"><w:multiLevelType w:val="hybridMultilevel"/>{levels}</w:abstractNum>'
    )
    existing = numbering.findall(qn("w:abstractNum"))
    if existing:
        existing[-1].addnext(abstract)
    else:
        numbering.insert(0, abstract)
    numbering.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{num_id}"><w:abstractNumId w:val="{abs_id}"/></w:num>'))
    return num_id


def list_item(doc, runs, num_id, level=0):
    p = doc.add_paragraph(style="List Paragraph")
    num_pr = p._p.get_or_add_pPr().get_or_add_numPr()
    num_pr.get_or_add_ilvl().val = level
    num_pr.get_or_add_numId().val = num_id
    p.paragraph_format.space_after = Pt(2)
    add_runs(p, runs)
    return p


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def cell_text(cell, runs, align=None, after=0):
    p = cell.paragraphs[0]
    add_runs(p, runs)
    p.paragraph_format.space_after = Pt(after)
    if align:
        p.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}[align]
    return p


def no_borders(table):
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "nil")
        borders.append(el)
    tbl_pr.append(borders)


def field(par, instr, placeholder="1"):
    def fld(kind):
        run = par.add_run()
        el = OxmlElement("w:fldChar")
        el.set(qn("w:fldCharType"), kind)
        run._r.append(el)

    fld("begin")
    run = par.add_run()
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = f" {instr} "
    run._r.append(it)
    fld("separate")
    par.add_run(placeholder)
    fld("end")


def hyperlink(par, url, text, color="0563C1"):
    r_id = par.part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    r_pr = OxmlElement("w:rPr")
    c = OxmlElement("w:color")
    c.set(qn("w:val"), color)
    r_pr.append(c)
    u = OxmlElement("w:u")
    u.set(qn("w:val"), "single")
    r_pr.append(u)
    run.append(r_pr)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    run.append(t)
    link.append(run)
    par._p.append(link)


def columns(section, num, space_twips=708):
    cols = section._sectPr.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        section._sectPr.append(cols)
    cols.set(qn("w:num"), str(num))
    cols.set(qn("w:space"), str(space_twips))


def picture(doc, path, width_cm, align="center"):
    doc.add_picture(path, width=Cm(width_cm))
    p = doc.paragraphs[-1]
    p.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}[align]
    return p


# ── Documents ──────────────────────────────────────────────────────────────────────────────────────────────────────


def c01_titulos_estilos(ctx):
    doc = new_doc("Calibri", 11)
    headings(doc, "Calibri Light")
    heading(doc, "Informe de actividad del tercer trimestre", 1)
    para(doc, POOL[0], "justify")
    heading(doc, "Evolución de las ventas", 2)
    para(
        doc,
        [
            "Las ventas crecieron en todas las regiones, con especial ",
            ("fuerza", {"b": True}),
            " en el norte y un comportamiento ",
            ("sorprendentemente estable", {"i": True}),
            " en el sur. Las cifras ",
            ("subrayadas", {"u": True}),
            " se revisarán en el próximo informe, y las ",
            ("tachadas", {"strike": True}),
            " ya no son válidas. La información ",
            ("en negrita y cursiva", {"b": True, "i": True}),
            " procede de la auditoría externa.",
        ],
        "justify",
    )
    heading(doc, "Colores y tamaños", 3)
    para(
        doc,
        [
            "Texto en ",
            ("rojo oscuro", {"color": "C00000"}),
            ", en ",
            ("verde", {"color": "00B050", "b": True}),
            ", en ",
            ("azul", {"color": "0070C0"}),
            " y en ",
            ("gris", {"color": "7F7F7F", "i": True}),
            ". Tamaños: ",
            ("ocho puntos", {"size": 8}),
            ", ",
            ("catorce puntos", {"size": 14}),
            " y ",
            ("dieciocho puntos", {"size": 18, "b": True}),
            ".",
        ],
    )
    heading(doc, "Alineaciones", 2)
    para(doc, "Este párrafo está centrado: resumen ejecutivo del trimestre.", "center")
    para(doc, "Este párrafo está alineado a la derecha — Madrid, 30 de septiembre de 2026", "right")
    para(doc, POOL[2], "justify")
    para(doc, POOL[3], "left")
    return doc, ["headings", "alignment", "bold", "italic", "underline", "strike", "colours", "sizes", "accents"]


def c02_listas(ctx):
    doc = new_doc("Arial", 11, after=6)
    headings(doc, "Arial", colors=("1F3864", "1F3864", "1F3864"))
    heading(doc, "Plan de acción para 2027", 1)
    para(doc, "El comité de dirección ha fijado las siguientes prioridades para el próximo ejercicio:")
    bullets = new_list(doc, "bullet")
    list_item(doc, "Reducir los tiempos de entrega en un 20 % mediante la automatización del almacén.", bullets)
    list_item(doc, "Ampliar la red comercial en el norte de la península:", bullets)
    list_item(doc, "abrir dos delegaciones nuevas en Bilbao y Oviedo;", bullets, 1)
    list_item(doc, "contratar a seis comerciales con experiencia en el sector.", bullets, 1)
    list_item(doc, ["Mejorar la ", ("satisfacción", {"b": True}), " de los clientes por encima del 90 %."], bullets)
    para(doc, "Para lograrlo se seguirán estos pasos, por orden de prioridad:", before=6)
    numbers = new_list(doc, "number")
    list_item(doc, "Analizar los procesos actuales y detectar los cuellos de botella.", numbers)
    list_item(doc, "Diseñar el nuevo flujo de trabajo con los responsables de cada área:", numbers)
    list_item(doc, "logística y transporte;", numbers, 1)
    list_item(doc, "atención al cliente y posventa.", numbers, 1)
    list_item(doc, "Implantar los cambios de forma gradual y medir los resultados cada mes.", numbers)
    para(doc, POOL[4], "justify", before=6)
    para(doc, "Calendario de revisiones (la numeración vuelve a empezar):")
    again = new_list(doc, "number")
    list_item(doc, "Primera revisión: enero de 2027.", again)
    list_item(doc, "Segunda revisión: junio de 2027.", again)
    list_item(doc, "Revisión final: diciembre de 2027.", again)
    return doc, ["lists", "bullets", "numbering", "two-levels", "restart"]


def c03_tabla(ctx):
    doc = new_doc("Calibri", 11)
    headings(doc, "Calibri")
    heading(doc, "Resultados por región", 1)
    para(doc, POOL[1], "justify")
    table = doc.add_table(rows=5, cols=4)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    header = ["Trimestre", "Región", "Ventas (€)", "Variación"]
    rows = [
        ["T1", "Norte", "1.250.000", "+10,4 %"],
        ["", "Sur", "980.000", "+6,6 %"],
        ["T2", "Norte", "1.410.000", "−1,1 %"],
        ["", "Sur", "1.045.000", "+3,2 %"],
    ]
    for c, text in enumerate(header):
        cell = table.cell(0, c)
        shade(cell, "1F4E79")
        cell_text(cell, [(text, {"b": True, "color": "FFFFFF"})], "center")
    for r, row in enumerate(rows, start=1):
        for c, text in enumerate(row):
            if text:
                cell_text(table.cell(r, c), text, "right" if c >= 2 else "left")
    table.cell(1, 0).merge(table.cell(2, 0))
    table.cell(3, 0).merge(table.cell(4, 0))
    para(doc, "")
    para(doc, POOL[10], "justify")
    small = doc.add_table(rows=3, cols=3)
    small.style = "Table Grid"
    title = small.cell(0, 0).merge(small.cell(0, 2))
    shade(title, "D9E2F3")
    cell_text(title, [("Resumen anual (cifras provisionales)", {"b": True})], "center")
    for c, text in enumerate(["Ingresos", "Gastos", "Resultado"]):
        cell_text(small.cell(1, c), [(text, {"b": True})], "center")
    for c, text in enumerate(["4.685.000 €", "3.910.000 €", "775.000 €"]):
        cell_text(small.cell(2, c), text, "right")
    para(doc, "")
    para(doc, "Las cifras del segundo trimestre están pendientes de la revisión final de la auditoría.", "left")
    return doc, ["table", "borders", "header-shading", "merged-cells", "numbers-right"]


def c04_imagenes(ctx):
    doc = new_doc("Calibri", 11)
    headings(doc, "Calibri")
    heading(doc, "Catálogo de portátiles", 1)
    para(doc, POOL[16], "justify")
    picture(doc, ctx["images"][0], 16)
    para(doc, [("Figura 1. Modelos disponibles en la tienda.", {"i": True, "size": 9, "color": "595959"})], "center")
    para(doc, POOL[17], "justify")
    picture(doc, ctx["images"][1 % len(ctx["images"])], 11, "left")
    para(doc, [("Figura 2. Ficha del producto con su precio.", {"i": True, "size": 9, "color": "595959"})], "left")
    para(doc, POOL[18], "justify")
    return doc, ["images", "captions"]


def c05_dos_columnas(ctx):
    doc = new_doc("Times New Roman", 11, after=6, line=1.0)
    headings(doc, "Times New Roman", sizes=(20, 13, 12), colors=("000000", "7B2C2C", "000000"))
    heading(doc, "Boletín informativo municipal", 1).alignment = WD_ALIGN_PARAGRAPH.CENTER
    para(doc, [("Número 42 · Otoño de 2026", {"i": True})], "center")
    para(doc, POOL[6], "justify")
    sec = doc.add_section(WD_SECTION.CONTINUOUS)
    columns(sec, 2)
    heading(doc, "Urbanismo", 2)
    para(doc, POOL[7], "justify")
    para(doc, POOL[25], "justify")
    heading(doc, "Cultura", 2)
    para(doc, POOL[16], "justify")
    para(doc, POOL[27], "justify")
    heading(doc, "Educación", 2)
    para(doc, POOL[18], "justify")
    para(doc, POOL[9], "justify")
    sec = doc.add_section(WD_SECTION.CONTINUOUS)
    columns(sec, 1)
    para(doc, [("Próximo número: invierno de 2026.", {"i": True})], "center", before=12)
    return doc, ["two-columns", "sections", "justify"]


def c06_encabezado_pie(ctx):
    doc = new_doc("Calibri", 11)
    headings(doc, "Calibri")
    sec = doc.sections[0]
    hp = sec.header.paragraphs[0]
    hp.paragraph_format.tab_stops.add_tab_stop(Cm(16), WD_TAB_ALIGNMENT.RIGHT)
    add_runs(hp, [("Memoria anual 2026 — Fundación Río Claro", {"size": 9, "color": "595959"}), ("\tConfidencial", {"size": 9, "b": True, "color": "C00000"})])
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_runs(fp, [("Página ", {"size": 9})])
    field(fp, "PAGE")
    add_runs(fp, [(" de ", {"size": 9})])
    field(fp, "NUMPAGES")
    heading(doc, "Memoria de actividades", 1)
    for k, i in enumerate([0, 1, 2, 3, 4, 5, 10, 11, 14, 15, 19, 20, 22, 23]):
        if k % 4 == 0 and k:
            heading(doc, ["Programas sociales", "Gestión y transparencia", "Perspectivas"][k // 4 - 1], 2)
        para(doc, POOL[i], "justify")
    return doc, ["header", "footer", "page-numbers", "multi-page"]


def c07_carta(ctx):
    doc = new_doc("Times New Roman", 12, page=LETTER, margins_cm=2.54, after=0, line=1.0)
    for line in ["Construcciones Peñalara, S.L.", "Calle Mayor, 25, 2.º B", "28013 Madrid", "Tel. 910 000 000"]:
        para(doc, line, "right")
    para(doc, "Madrid, 14 de octubre de 2026", "right", before=18, after=18)
    for line in ["Sra. Dña. Lucía Muñoz Ibáñez", "Directora de Compras", "Avenida de la Constitución, 8", "41004 Sevilla"]:
        para(doc, line)
    para(doc, [("Asunto: ", {"b": True}), "renovación del contrato de mantenimiento"], before=18, after=12)
    para(doc, "Estimada señora Muñoz:", after=12)
    para(
        doc,
        [
            "Nos complace comunicarle que, tras analizar su propuesta, hemos decidido renovar el contrato de mantenimiento "
            "de las instalaciones por un periodo adicional de ",
            ("doce meses", {"i": True}),
            ", en las mismas condiciones económicas acordadas el año pasado y con la posibilidad de revisar las tarifas "
            "si el índice de precios de consumo supera el 3 %.",
        ],
        "justify",
        after=12,
    )
    para(doc, POOL[8], "justify", after=12)
    para(doc, [("Le recordamos que el plazo para firmar el nuevo contrato finaliza el 30 de noviembre de 2026.", {"b": True, "color": "1F4E79"})], after=12)
    para(doc, "Quedamos a su disposición para cualquier aclaración y aprovechamos la ocasión para saludarla atentamente.", "justify", after=24)
    para(doc, "Atentamente,", after=36)
    para(doc, [("Javier Ortega Núñez", {"b": True})])
    para(doc, "Director General")
    return doc, ["letter", "right-aligned-block", "justify", "italic-run", "coloured-bold-line", "letter-size"]


def c08_notas(ctx):
    doc = new_doc("Georgia", 11, after=8)
    headings(doc, "Georgia", sizes=(15, 12, 11), colors=("000000", "000000", "000000"))
    heading(doc, "Notas sobre el consumo energético", 1)
    para(
        doc,
        [
            "El edificio principal consume 145 kWh/m",
            ("2", {"sup": True}),
            " al año",
            ("1", {"sup": True}),
            ", muy por encima de la media del sector. La superficie útil es de 3.200 m",
            ("2", {"sup": True}),
            " y el volumen climatizado alcanza los 9.600 m",
            ("3", {"sup": True}),
            ".",
        ],
        "justify",
    )
    para(
        doc,
        [
            "Las emisiones de CO",
            ("2", {"sub": True}),
            " se calcularon con los factores oficiales",
            ("2", {"sup": True}),
            " y el consumo de agua (H",
            ("2", {"sub": True}),
            "O) se midió con contadores individuales en cada planta",
            ("3", {"sup": True}),
            ".",
        ],
        "justify",
    )
    para(doc, POOL[4], "justify")
    para(doc, [POOL[25], ("4", {"sup": True})], "justify")
    heading(doc, "Notas", 2)
    for n, text in enumerate(
        [
            "Datos del ejercicio 2025, según las facturas de la compañía eléctrica.",
            "Factores de emisión publicados por el ministerio en marzo de 2026.",
            "Instalados en enero de 2026; los datos anteriores son estimaciones.",
            "Importe financiado en un 40 % con fondos europeos.",
        ],
        start=1,
    ):
        para(doc, [(str(n), {"sup": True, "size": 9}), (" " + text, {"size": 9})], after=2)
    return doc, ["superscript", "subscript", "footnote-marks", "georgia"]


def c09_enlaces(ctx):
    doc = new_doc("Calibri", 11)
    headings(doc, "Calibri")
    heading(doc, "Recursos en línea", 1)
    p = para(doc, "Puede consultar las bases completas de la convocatoria en la ")
    hyperlink(p, "https://www.example.org/convocatoria-2026", "sede electrónica del ayuntamiento")
    add_runs(p, " y descargar los formularios desde la misma página. Para cualquier duda, escriba a ")
    hyperlink(p, "mailto:atencion@example.org", "atencion@example.org")
    add_runs(p, ".")
    para(doc, POOL[26], "justify")
    para(doc, "Enlaces de interés:")
    bullets = new_list(doc, "bullet")
    for url, text in [
        ("https://www.example.org/ayudas", "Ayudas y subvenciones"),
        ("https://www.example.org/calendario", "Calendario del contribuyente"),
        ("https://www.example.org/transparencia", "Portal de transparencia"),
    ]:
        item = list_item(doc, "", bullets)
        hyperlink(item, url, text)
    p = para(doc, "Dirección completa del portal: ", before=8)
    hyperlink(p, "https://www.example.org/", "https://www.example.org/")
    return doc, ["hyperlinks", "mailto", "bullets"]


def c10_informe_largo(ctx):
    doc = new_doc("Georgia", 12, after=8, line=1.5)
    headings(doc, "Georgia", sizes=(16, 13, 12), colors=("1F3864", "1F3864", "1F3864"))
    sec = doc.sections[0]
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    add_runs(fp, [("Página ", {"size": 9})])
    field(fp, "PAGE")
    para(doc, [("Informe anual de gestión 2026", {"size": 24, "b": True, "color": "1F3864"})], "center", after=4)
    para(doc, [("Documento para el consejo de administración", {"i": True, "color": "595959"})], "center", after=18)
    sections = [
        ("1. Resumen ejecutivo", [0, 1, 2]),
        ("2. Situación financiera", [3, 10, 20]),
        ("3. Operaciones", [4, 5, 15]),
        ("4. Personas y organización", [18, 24, 28]),
        ("5. Entorno y comunidad", [6, 7, 12, 13, 21, 26]),
        ("6. Servicios al cliente", [22, 23, 16, 17]),
        ("7. Riesgos y perspectivas", [8, 9, 11, 14, 19, 25, 27]),
    ]
    for title, idx in sections:
        heading(doc, title, 1)
        for n, i in enumerate(idx):
            if n == 2 and len(idx) > 4:
                heading(doc, "Aspectos destacados", 2)
            para(doc, POOL[i], "justify")
    return doc, ["long-text", "five-pages", "footer", "page-numbers", "headings", "justify", "georgia"]


def c11_fuentes(ctx):
    doc = new_doc("Calibri", 11)
    headings(doc, "Calibri")
    heading(doc, "Muestrario de fuentes", 1)
    for font in ["Calibri", "Times New Roman", "Arial", "Georgia"]:
        p = para(doc, [(font, {"font": font, "b": True, "size": 14})], before=10, after=4)
        p.paragraph_format.keep_with_next = True
        para(
            doc,
            [
                ("Texto normal en " + font + " con acentos: canción, pingüino, año, 25 €. ", {"font": font}),
                ("Negrita. ", {"font": font, "b": True}),
                ("Cursiva. ", {"font": font, "i": True}),
                ("Negrita cursiva.", {"font": font, "b": True, "i": True}),
            ],
            after=4,
        )
        para(
            doc,
            [(f"{s} pt ", {"font": font, "size": s}) for s in (8, 10, 12, 16, 20)] + [("28 pt", {"font": font, "size": 28})],
            after=6,
        )
    return doc, ["fonts", "calibri", "times", "arial", "georgia", "sizes", "bold-italic"]


def c12_horizontal(ctx):
    doc = new_doc("Arial", 10)
    headings(doc, "Arial", sizes=(16, 13, 11), colors=("000000", "000000", "000000"))
    heading(doc, "Previsión mensual de producción", 1)
    para(doc, POOL[17], "justify")
    para(doc, "La tabla de la página siguiente se presenta en orientación horizontal para facilitar su lectura.")
    sec = doc.add_section(WD_SECTION.NEW_PAGE)
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = A4[1], A4[0]
    heading(doc, "Producción prevista por línea (toneladas)", 2)
    months = ["Línea", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio"]
    data = [
        ["Envasado A", "120", "115", "130", "128", "140", "150"],
        ["Envasado B", "95", "90", "102", "99", "110", "118"],
        ["Conservas", "60", "64", "70", "75", "72", "80"],
        ["Congelados", "45", "48", "50", "52", "58", "61"],
        ["Total", "320", "317", "352", "354", "380", "409"],
    ]
    table = doc.add_table(rows=6, cols=7)
    table.style = "Table Grid"
    for c, text in enumerate(months):
        cell = table.cell(0, c)
        shade(cell, "D9D9D9")
        cell_text(cell, [(text, {"b": True})], "center")
    for r, row in enumerate(data, start=1):
        for c, text in enumerate(row):
            cell_text(table.cell(r, c), [(text, {"b": r == 5})], "left" if c == 0 else "right")
    para(doc, "")
    para(doc, POOL[21], "justify")
    return doc, ["landscape", "sections", "wide-table"]


def c13_factura(ctx):
    doc = new_doc("Arial", 10, after=4, line=1.0)
    top = doc.add_table(rows=1, cols=2)
    no_borders(top)
    left = top.cell(0, 0).paragraphs[0]
    left.add_run().add_picture(ctx["images"][0], width=Cm(7))
    right = top.cell(0, 1)
    cell_text(right, [("Informática del Sur, S.L.", {"b": True, "size": 12})], "right")
    for line in ["CIF B-00000000", "Calle Sierpes, 12 · 41004 Sevilla", "facturas@example.com"]:
        p = right.add_paragraph()
        add_runs(p, line)
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        p.paragraph_format.space_after = Pt(0)
    para(doc, [("FACTURA", {"b": True, "size": 22, "color": "1F4E79"})], before=12, after=6)
    info = doc.add_table(rows=1, cols=2)
    no_borders(info)
    cell_text(info.cell(0, 0), [("Cliente: ", {"b": True}), "Academia Ñandú, S.A."])
    for line in ["Plaza de España, 3", "50001 Zaragoza"]:
        p = info.cell(0, 0).add_paragraph(line)
        p.paragraph_format.space_after = Pt(0)
    cell_text(info.cell(0, 1), [("Factura n.º: ", {"b": True}), "2026-0457"], "right")
    for line in ["Fecha: 02/10/2026", "Vencimiento: 01/11/2026"]:
        p = info.cell(0, 1).add_paragraph(line)
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        p.paragraph_format.space_after = Pt(0)
    para(doc, "")
    items = [
        ("Portátil HP 15 con Ryzen 5", "4", "490,00 €", "1.960,00 €"),
        ("Monitor de 27 pulgadas", "4", "189,90 €", "759,60 €"),
        ("Teclado y ratón inalámbricos", "4", "34,50 €", "138,00 €"),
        ("Instalación y configuración", "1", "120,00 €", "120,00 €"),
        ("Garantía ampliada a tres años", "4", "45,00 €", "180,00 €"),
    ]
    table = doc.add_table(rows=len(items) + 1, cols=4)
    table.style = "Table Grid"
    for c, text in enumerate(["Concepto", "Cantidad", "Precio unitario", "Importe"]):
        cell = table.cell(0, c)
        shade(cell, "1F4E79")
        cell_text(cell, [(text, {"b": True, "color": "FFFFFF"})], "left" if c == 0 else "right")
    for r, row in enumerate(items, start=1):
        for c, text in enumerate(row):
            cell_text(table.cell(r, c), text, "left" if c == 0 else "right")
    para(doc, "")
    totals = doc.add_table(rows=3, cols=2)
    no_borders(totals)
    totals.alignment = WD_TABLE_ALIGNMENT.RIGHT
    for r, (label, value) in enumerate([("Base imponible", "3.157,60 €"), ("IVA (21 %)", "663,10 €"), ("Total", "3.820,70 €")]):
        bold = r == 2
        cell_text(totals.cell(r, 0), [(label, {"b": bold})], "right")
        cell_text(totals.cell(r, 1), [(value, {"b": bold})], "right")
    para(doc, "")
    para(doc, [("Forma de pago: ", {"b": True}), "transferencia bancaria a la cuenta ES00 1234 5678 9012 3456 7890."], before=12)
    para(doc, [("Gracias por su confianza.", {"i": True, "color": "595959"})])
    return doc, ["invoice", "layout-tables", "image", "table", "totals", "right-aligned"]


def c14_mixto(ctx):
    doc = new_doc("Calibri", 11)
    headings(doc, "Calibri", colors=("2E74B5", "2E74B5", "1F4D78"))
    para(doc, [("Guía rápida del nuevo servicio", {"size": 24, "b": True, "color": "2E74B5"})], "center", after=2)
    para(doc, [("Todo lo que necesita saber para empezar", {"i": True, "size": 13, "color": "7F7F7F"})], "center", after=14)
    heading(doc, "Cómo darse de alta", 1)
    para(doc, POOL[26], "justify")
    steps = new_list(doc, "number")
    list_item(doc, "Rellene el formulario de solicitud.", steps)
    list_item(doc, "Adjunte la documentación necesaria:", steps)
    list_item(doc, "copia del documento de identidad;", steps, 1)
    list_item(doc, "certificado de empadronamiento.", steps, 1)
    list_item(doc, "Espere la confirmación por correo electrónico.", steps)
    heading(doc, "Tarifas", 1)
    table = doc.add_table(rows=4, cols=3)
    table.style = "Table Grid"
    for r, row in enumerate([["Modalidad", "Precio mensual", "Permanencia"], ["Básica", "9,90 €", "Sin permanencia"], ["Completa", "19,90 €", "12 meses"], ["Empresa", "49,00 €", "24 meses"]]):
        for c, text in enumerate(row):
            if r == 0:
                shade(table.cell(r, c), "DEEAF6")
            cell_text(table.cell(r, c), [(text, {"b": r == 0})], "right" if (c == 1 and r) else "left")
    para(doc, "")
    picture(doc, ctx["images"][1 % len(ctx["images"])], 9, "center")
    heading(doc, "Ventajas", 2)
    bullets = new_list(doc, "bullet")
    list_item(doc, "Atención personalizada todos los días del año.", bullets)
    list_item(doc, ["Sin costes ocultos", ("1", {"sup": True}), "."], bullets)
    list_item(doc, "Cancelación gratuita durante el primer mes.", bullets)
    p = para(doc, "Más información en ", before=8)
    hyperlink(p, "https://www.example.org/servicio", "www.example.org/servicio")
    add_runs(p, ".")
    para(doc, [("1", {"sup": True, "size": 9}), (" Impuestos incluidos en todas las modalidades.", {"size": 9})], before=12)
    return doc, ["mixed", "title", "lists", "table", "image", "superscript", "hyperlink"]


def c15_espaciado(ctx):
    doc = new_doc("Calibri", 11, after=6)
    headings(doc, "Calibri")
    heading(doc, "Sangrías e interlineados", 1)
    para(doc, POOL[12], "justify", first=1.25)
    para(doc, POOL[13], "justify", first=1.25)
    para(doc, [(POOL[5], {"i": True})], "justify", left=2, right=2, before=6, after=12)
    heading(doc, "Interlineado sencillo", 2)
    para(doc, POOL[19], "left", line=1.0)
    heading(doc, "Interlineado de 1,5 líneas", 2)
    para(doc, POOL[20], "left", line=1.5)
    heading(doc, "Interlineado doble", 2)
    para(doc, POOL[21], "left", line=2.0)
    heading(doc, "Sangría francesa", 2)
    para(doc, [("Artículo 1. ", {"b": True}), POOL[27]], "justify", left=1.5, first=-1.5)
    para(doc, [("Artículo 2. ", {"b": True}), POOL[28]], "justify", left=1.5, first=-1.5)
    return doc, ["indents", "first-line-indent", "hanging-indent", "line-spacing", "block-quote"]


def c16_tabuladores(ctx):
    doc = new_doc("Calibri", 11, after=4)
    headings(doc, "Calibri")
    heading(doc, "Índice", 1)
    for title, page, level in [
        ("1. Introducción", "3", 0),
        ("2. Metodología", "5", 0),
        ("2.1. Recogida de datos", "6", 1),
        ("2.2. Análisis estadístico", "9", 1),
        ("3. Resultados", "12", 0),
        ("4. Conclusiones y recomendaciones", "18", 0),
    ]:
        p = para(doc, f"{title}\t{page}", left=0.75 * level)
        p.paragraph_format.tab_stops.add_tab_stop(Cm(16), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
    heading(doc, "Carta de postres", 1)
    for dish, price in [("Tarta de queso con arándanos", "5,50 €"), ("Flan casero de huevo", "4,00 €"), ("Crema catalana", "4,50 €"), ("Helado artesano (dos bolas)", "3,75 €")]:
        p = para(doc, f"{dish}\t{price}")
        p.paragraph_format.tab_stops.add_tab_stop(Cm(12), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
    heading(doc, "Horario", 1)
    for day, hours in [("Lunes a jueves", "13:00 – 16:00"), ("Viernes y sábado", "13:00 – 23:30"), ("Domingo", "Cerrado")]:
        p = para(doc, f"{day}\t{hours}")
        p.paragraph_format.tab_stops.add_tab_stop(Cm(8), WD_TAB_ALIGNMENT.CENTER)
    para(doc, POOL[29], "justify", before=10)
    return doc, ["tabs", "dot-leaders", "right-tab", "centre-tab"]


DOCS = [
    ("c01-titulos-estilos", c01_titulos_estilos),
    ("c02-listas", c02_listas),
    ("c03-tabla", c03_tabla),
    ("c04-imagenes", c04_imagenes),
    ("c05-dos-columnas", c05_dos_columnas),
    ("c06-encabezado-pie", c06_encabezado_pie),
    ("c07-carta", c07_carta),
    ("c08-notas", c08_notas),
    ("c09-enlaces", c09_enlaces),
    ("c10-informe-largo", c10_informe_largo),
    ("c11-fuentes", c11_fuentes),
    ("c12-horizontal", c12_horizontal),
    ("c13-factura", c13_factura),
    ("c14-mixto", c14_mixto),
    ("c15-espaciado", c15_espaciado),
    ("c16-tabuladores", c16_tabuladores),
]


def test_pattern_png(path, w=640, h=160):
    """A small PNG (blue band with stripes) for when no --image is given."""
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            stripe = (x // 40 + y // 40) % 2
            row += bytes((31, 73, 125) if stripe else (220, 228, 240))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    return path


def export(word_export, docx_path, pdf_path):
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", word_export, "-In", docx_path, "-Out", pdf_path]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    out = (res.stdout or "").strip()
    if res.returncode != 0 or not os.path.exists(pdf_path):
        raise RuntimeError(f"Word export failed ({res.returncode}): {out} {(res.stderr or '').strip()[:400]}")
    m = re.search(r"pages=(\d+)", out)
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--image", action="append", default=[])
    ap.add_argument("--word-export")
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    images = [os.path.abspath(p) for p in args.image] or [test_pattern_png(os.path.join(out, "_pattern.png"))]
    ctx = {"images": images}
    manifest_path = os.path.join(out, "manifest.json")
    manifest = {"version": 1, "documents": []}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf8") as f:
            manifest = json.load(f)
    entries = {d["id"]: d for d in manifest.get("documents", [])}
    failures = 0
    for doc_id, build in DOCS:
        if args.only and not re.search(args.only, doc_id):
            continue
        docx_path = os.path.join(out, doc_id + ".docx")
        pdf_path = os.path.join(out, doc_id + ".pdf")
        try:
            doc, features = build(ctx)
            core = doc.core_properties
            core.title = doc_id
            core.author = "LocalPDF corpus"
            core.created = datetime.datetime(2026, 9, 26)
            doc.save(docx_path)
            entry = entries.get(doc_id, {})
            entry.update({"id": doc_id, "set": "corpus", "pdf": doc_id + ".pdf", "gt": doc_id + ".docx", "features": features})
            if args.word_export:
                stale = not os.path.exists(pdf_path) or os.path.getmtime(pdf_path) < os.path.getmtime(docx_path)
                if stale or args.force:
                    entry["pages"] = export(args.word_export, docx_path, pdf_path)
            entries[doc_id] = entry
            print(f"ok    {doc_id}  pages={entry.get('pages')}  {', '.join(features)}", flush=True)
        except Exception as err:  # keep building the rest
            failures += 1
            print(f"FAIL  {doc_id}: {err}", flush=True)
    order = {doc_id: n for n, (doc_id, _) in enumerate(DOCS)}
    manifest["documents"] = sorted(entries.values(), key=lambda d: (order.get(d["id"], 999), d["id"]))
    with open(manifest_path, "w", encoding="utf8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"manifest: {manifest_path} ({len(manifest['documents'])} documents)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
