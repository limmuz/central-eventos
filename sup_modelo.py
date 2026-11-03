"""Planilha do requisitante + Suprimentos no MESMO arquivo-modelo do setor (modelos/MODELO SUPRIMENTOS.xlsx).

O arquivo é editado direto no XML (sem abrir e salvar pelo openpyxl), para manter tudo o que o Excel tem nele:
listas suspensas, tabelas, consulta da aba "Lista suspensa", comentários, estilos e fórmulas. Só mudam:
  - Planilha requisitante: datas e totais das contas (linha 2), as linhas de rateio e a Engenharia (fórmula) no fim;
  - Planilha Suprimentos: uma linha de item para cada linha da requisitante (fórmulas iguais às do modelo).
Correções nas fórmulas do modelo (o original sempre usava a coluna de energia e pegava o total errado):
  - QUANTIDADE usa a coluna da conta do agente escolhido em F2 (Eletropaulo = energia, Cia Saneamento = água, Comgás = gás);
  - VALOR TOTAL do documento usa o total dessa conta; centro de custo / projeto caem no código do site se o nome não
    estiver nas listas.
"""
import datetime as dt
import io
import re
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

MODELO = Path(__file__).resolve().parent / "modelos" / "MODELO SUPRIMENTOS.xlsx"
NOME_AGENTE = {"energia": "Eletropaulo", "agua": "Cia Saneamento", "gas": "Comgás"}


def _col(c):
    n = 0
    for ch in c:
        n = n * 26 + ord(ch) - 64
    return n


def _txt(ref, valor, estilo):
    if valor in (None, ""):
        return f'<c r="{ref}" s="{estilo}"/>'
    return f'<c r="{ref}" s="{estilo}" t="inlineStr"><is><t xml:space="preserve">{escape(str(valor))}</t></is></c>'


def _num(ref, valor, estilo):
    if valor in (None, ""):
        return f'<c r="{ref}" s="{estilo}"/>'
    return f'<c r="{ref}" s="{estilo}"><v>{round(float(valor), 2)}</v></c>'


def _f(ref, formula, estilo, texto=False):
    tipo = ' t="str"' if texto else ""
    return f'<c r="{ref}" s="{estilo}"{tipo}><f>{escape(formula)}</f></c>'


def _estilos(linha_xml):
    """{coluna: estilo} de uma <row> do modelo."""
    return {m.group(1): m.group(2) for m in re.finditer(r'<c r="([A-Z]+)\d+" s="(\d+)"', linha_xml)}


def _linha(xml, n):
    m = re.search(rf'<row r="{n}"[^>]*>.*?</row>', xml, re.S)
    return m.group(0) if m else ""


def _listas(z):
    """Nome do centro de custo e do projeto (como estão nas listas do modelo) para cada código."""
    try:
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(z), read_only=True, data_only=True)
        ws = wb["Lista suspensa"]
        cc, pj = {}, {}
        for row in ws.iter_rows(min_row=2, values_only=True):
            row = list(row) + [None] * 20
            if row[3] and row[4]:
                cc.setdefault(str(row[4]).split(".")[0], str(row[3]))
            if row[18] and row[19] and str(row[19]).strip().lower() != "cod. projeto":
                pj.setdefault(str(row[19]).split(".")[0], str(row[18]))
        return cc, pj
    except Exception:
        return {}, {}


def gerar(d, cfg, dcc, dpj, agente="energia"):
    """d = sup.calcular(con, mes). Devolve os bytes do .xlsx no formato do modelo."""
    if not MODELO.exists():
        raise FileNotFoundError(f"Falta o arquivo-modelo: {MODELO}")
    original = MODELO.read_bytes()
    cc_nome, pj_nome = _listas(original)
    zin = zipfile.ZipFile(io.BytesIO(original))
    arq = {n: zin.read(n) for n in zin.namelist()}

    linhas = d["linhas"]
    n = len(linhas)
    ini, eng = 4, 4 + n                       # linhas de rateio: 4 .. eng-1 ; Engenharia: eng
    ultima = eng

    # ------------------------------------------------------------------ Planilha requisitante (sheet1)
    s1 = arq["xl/worksheets/sheet1.xml"].decode("utf-8")
    r1, r2, r3, rd, re_ = (_linha(s1, k) for k in (1, 2, 3, 4, 24))
    e1, e2, e3, ed, ee = (_estilos(x) for x in (r1, r2, r3, rd, re_))
    contas = d["contas"]
    nome_u = {"energia": "Energia", "agua": "Água", "gas": "Gás"}
    forn = {u: " + ".join(c["fornecedor"] for c in contas if c["utilidade"] == u and c["fornecedor"]) or nome_u[u] for u in nome_u}
    br = lambda iso: dt.date.fromisoformat(iso).strftime("%d/%m/%y") if iso else ""
    datas = lambda campo: "; ".join(f"{c['fornecedor'] or nome_u[c['utilidade']]} - {br(c[campo])}" for c in contas if c[campo])
    T = d["totais"]["contas"]
    rows = []
    attrs = 'spans="1:9" x14ac:dyDescent="0.25"'
    rows.append(f'<row r="1" {attrs}>' + _txt("A1", "Data de emissão", e1.get("A", "17")) + _txt("B1", "Data de vencimento", e1.get("B", "17"))
                + _txt("C1", forn["energia"], e1.get("C", "17")) + _txt("D1", forn["agua"], e1.get("D", "17")) + _txt("E1", forn["gas"], e1.get("E", "17"))
                + f'<c r="F1" s="{e1.get("F", "17")}"/></row>')
    rows.append(f'<row r="2" {attrs}>' + _txt("A2", datas("data_emissao"), e2.get("A", "64")) + _txt("B2", datas("data_vencimento"), e2.get("B", "64"))
                + _num("C2", T["energia"], e2.get("C", "63")) + _num("D2", T["agua"], e2.get("D", "63")) + _num("E2", T["gas"], e2.get("E", "63"))
                + _txt("F2", NOME_AGENTE[agente], e2.get("F", "39")) + "</row>")
    rows.append(r3)                                       # cabeçalho da tabela: igual ao modelo
    for i, l in enumerate(linhas):
        r = ini + i
        cc = cc_nome.get(l["centro_custo"]) or dcc.get(l["centro_custo"]) or l["centro_custo"]
        pj = pj_nome.get(l["projeto"]) or l["descricao"] or dpj.get(l["projeto"]) or l["projeto"]
        obs = (l["observacao"] or "").replace("valores do Relatório de eventos", "").strip()
        if l["desc_pct"]:
            obs = (obs + f" desconto de {l['desc_pct']:g}%").strip()
        rows.append(f'<row r="{r}" {attrs}>' + _txt(f"A{r}", cc, ed.get("A", "67")) + _txt(f"B{r}", pj, ed.get("B", "68"))
                    + _num(f"C{r}", l["cobrado"]["energia"] or None, ed.get("C", "76")) + _num(f"D{r}", l["cobrado"]["agua"] or None, ed.get("D", "76"))
                    + _num(f"E{r}", l["cobrado"]["gas"] or None, ed.get("E", "76")) + _txt(f"F{r}", obs, ed.get("F", "75")) + "</row>")
    cc_eng = cc_nome.get(cfg["cc_engenharia"]) or "Engenharia"
    pj_eng = pj_nome.get(cfg["projeto_engenharia"]) or "Engenharia"
    soma = lambda c: f"{c}2-SUM({c}{ini}:{c}{eng - 1})" if n else f"{c}2"
    rows.append(f'<row r="{eng}" {attrs}>' + _txt(f"A{eng}", cc_eng, ee.get("A", "71")) + _txt(f"B{eng}", pj_eng, ee.get("B", "72"))
                + "".join(_f(f"{c}{eng}", soma(c), ee.get(c, "77")) for c in "CDE") + f'<c r="F{eng}" s="{ee.get("F", "75")}"/></row>')
    s1 = re.sub(r"<sheetData>.*</sheetData>", "<sheetData>" + "".join(rows) + "</sheetData>", s1, flags=re.S)
    s1 = re.sub(r'<dimension ref="[^"]*"/>', f'<dimension ref="A1:F{ultima}"/>', s1)
    s1 = re.sub(r'(<dataValidation type="decimal"[^>]*sqref=")[^"]*"', rf'\g<1>C{ini}:E{ultima}"', s1)
    s1 = re.sub(r'(<dataValidation type="list"[^>]*sqref=")[^"]*"', rf'\g<1>B{ini}:B{ultima}"', s1)
    s1 = re.sub(r"(<xm:sqref>)A4:A\d+(</xm:sqref>)", rf"\g<1>A{ini}:A{ultima}\g<2>", s1)
    s1 = s1.replace('<selection activeCell="E2" sqref="E2"/>', '<selection activeCell="A4" sqref="A4"/>')
    arq["xl/worksheets/sheet1.xml"] = s1.encode("utf-8")
    t1 = arq["xl/tables/table1.xml"].decode("utf-8")
    t1 = re.sub(r'ref="A3:F\d+"', f'ref="A3:F{ultima}"', t1)
    arq["xl/tables/table1.xml"] = t1.encode("utf-8")

    # ------------------------------------------------------------------ Planilha Suprimentos (sheet2)
    s2 = arq["xl/worksheets/sheet2.xml"].decode("utf-8")
    q1, q2, q3, qd = (_linha(s2, k) for k in (1, 2, 3, 4))
    f2, fd = _estilos(q2), _estilos(qd)
    R = "'Planilha requisitante'!"
    cab = (f'<row r="2" spans="1:19" x14ac:dyDescent="0.25">'
           + _txt("A2", "@", f2.get("A", "5"))
           + f'<c r="B2" s="{f2.get("B", "6")}"><f ca="1">TODAY()</f></c>'
           + _f("C2", f'IF({R}A2="","",{R}A2)', f2.get("C", "6"), True)
           + _f("D2", f'IF({R}B2="","",{R}B2)', f2.get("D", "6"), True)
           + f'<c r="E2" s="{f2.get("E", "5")}"/>'                                   # nº do documento: digitar
           + _f("F2", f'IF(M2=7002,{R}D2,IF(M2=7003,{R}E2,{R}C2))', f2.get("F", "59"))
           + _f("G2", f'IF(M2=7002,"ÁGUA",IF(M2=7003,"GÁS","ENERGIA"))&" {d["mes"][5:]}/{d["mes"][:4]}"', f2.get("G", "5"), True)
           + _num("H2", cfg.get("organizacao", 2), f2.get("H", "5")) + _num("I2", cfg.get("filial", 3), f2.get("I", "5"))
           + _num("J2", cfg.get("acao", 100), f2.get("J", "5"))
           + _f("K2", 'IF(OR(M2=7002,M2=7003),"-","3")', f2.get("K", "5"), True)
           + _txt("L2", "RECIBO", f2.get("L", "5"))
           + _f("M2", f"VLOOKUP({R}F2,Tabela4[],2,0)", f2.get("M", "5"))
           + _num("N2", 0, f2.get("N", "5")) + _txt("O2", "CIF", f2.get("O", "5"))
           + _f("P2", "F2", f2.get("P", "5")) + _f("Q2", "E2", f2.get("Q", "5")) + _num("R2", 1, f2.get("R", "5")) + _f("S2", "F2", f2.get("S", "5"))
           + "</row>")
    itens = []
    qtd = ('IF($M$2=7002,Tabela1[[#This Row],[Quantidade Água2]],IF($M$2=7003,Tabela1[[#This Row],[Quantidade Gás]],'
           'Tabela1[[#This Row],[Quantidade Energia]]))')
    codigos = [(l["centro_custo"], l["projeto"]) for l in linhas] + [(cfg["cc_engenharia"], cfg["projeto_engenharia"])]
    for i, (cc, pj) in enumerate(codigos):
        r = ini + i
        fb = lambda x: x if str(x).isdigit() else '""'
        itens.append(f'<row r="{r}" spans="1:19" x14ac:dyDescent="0.25">'
                     + _txt(f"A{r}", "!", fd.get("A", "5")) + _num(f"B{r}", 1, fd.get("B", "19"))
                     + _f(f"C{r}", f"IFERROR(VLOOKUP(Tabela1[[#This Row],[Centro de custo]],Tabela7[],2,0),{fb(cc)})", fd.get("C", "57"))
                     + _f(f"D{r}", f"IFERROR(VLOOKUP(Tabela1[[#This Row],[Projeto]],Tabela20_2[],2,0),{fb(pj)})", fd.get("D", "55"))
                     + _num(f"E{r}", i + 1, fd.get("E", "5"))
                     + _f(f"F{r}", 'IF($M$2=7003,"903",IF($M$2=7001,"901","902"))', fd.get("F", "5"), True)
                     + _f(f"G{r}", 'IF(OR($M$2=7002,$M$2=7003),"801","802")', fd.get("G", "5"), True)
                     + _f(f"H{r}", 'IF($M$2=7002,"702",IF($M$2=7001,"701","703"))', fd.get("H", "5"), True)
                     + _f(f"I{r}", f'IF({qtd}="","",{qtd})', fd.get("I", "61"))
                     + _f(f"J{r}", f'IF(Tabela2[[#This Row],[QUANTIDADE]]="","",I{r}*B{r})', fd.get("J", "62"))
                     + _f(f"K{r}", "Tabela2[[#This Row],[Valor Total]]", fd.get("K", "62"))
                     + _num(f"L{r}", 0, fd.get("L", "18"))
                     + _f(f"M{r}", "Tabela2[[#This Row],[Valor Total]]", fd.get("M", "60"))
                     + _f(f"N{r}", "IF(OR($M$2=7003,$M$2=7002),1933,1253)", fd.get("N", "5"))
                     + "</row>")
    s2 = re.sub(r"<sheetData>.*</sheetData>", "<sheetData>" + q1 + cab + q3 + "".join(itens) + "</sheetData>", s2, flags=re.S)
    s2 = re.sub(r'<dimension ref="[^"]*"/>', f'<dimension ref="A1:S{ultima}"/>', s2)
    arq["xl/worksheets/sheet2.xml"] = s2.encode("utf-8")
    t2 = arq["xl/tables/table2.xml"].decode("utf-8")
    t2 = re.sub(r'ref="A3:N\d+"', f'ref="A3:N{ultima}"', t2)
    t2 = re.sub(r"(<tableColumn [^>]*name=\"QUANTIDADE\"[^>]*>)<calculatedColumnFormula>.*?</calculatedColumnFormula>",
                lambda m: m.group(1) + "<calculatedColumnFormula>" + escape(f'IF({qtd}="","",{qtd})') + "</calculatedColumnFormula>", t2)
    arq["xl/tables/table2.xml"] = t2.encode("utf-8")

    # ------------------------------------------------------------------ recalcular ao abrir (sem cadeia de cálculo antiga)
    wbx = arq["xl/workbook.xml"].decode("utf-8")
    wbx = re.sub(r"<calcPr([^>]*?)/>", lambda m: "<calcPr" + re.sub(r'\s*fullCalcOnLoad="[^"]*"', "", m.group(1)) + ' fullCalcOnLoad="1"/>', wbx)
    arq["xl/workbook.xml"] = wbx.encode("utf-8")
    arq.pop("xl/calcChain.xml", None)
    rels = arq["xl/_rels/workbook.xml.rels"].decode("utf-8")
    arq["xl/_rels/workbook.xml.rels"] = re.sub(r'<Relationship [^>]*Target="calcChain.xml"/>', "", rels).encode("utf-8")
    ct = arq["[Content_Types].xml"].decode("utf-8")
    arq["[Content_Types].xml"] = re.sub(r'<Override PartName="/xl/calcChain.xml"[^>]*/>', "", ct).encode("utf-8")

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for nome in zin.namelist():
            if nome in arq:
                zout.writestr(zin.getinfo(nome), arq[nome])
    return out.getvalue()
