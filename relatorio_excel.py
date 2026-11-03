"""Excel "relatório desta tela" do Relatório de eventos (Visão geral, Evento, Avarias, Manutenção, Comparar).

Cada arquivo tem:
- PAINEL: indicadores, resumos e gráficos. As fórmulas usam SUBTOTAL, então os números e os gráficos
  acompanham os filtros das tabelas (filtrar a tabela de dados por categoria, evento, item, mês... muda o painel).
- abas de dados: Tabelas do Excel com filtro em todas as colunas (data, mês, categoria, gênero, evento, item...).
- abas de resumo (por item, por evento, por tipo...): tabelas prontas com filtro.
"""
import datetime as dt
from io import BytesIO

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.chart.text import RichText
from openpyxl.drawing.line import LineProperties
from openpyxl.drawing.text import CharacterProperties, Paragraph, ParagraphProperties, RichTextProperties
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

import calculos
import db
import pivo
from exporter import (BRL, DATA, FONTE, INT, NUM, ROXO, ROXO_100, ROXO_1000, ROXO_900, VERDE_200, VERDE_900, _d, _faixa,
                      _tabela)

MES = 'mmm/yy'
PCT = '0.0%'
SIMNAO = '"SIM";;"NÃO"'
CORES = ["8D0DE3", "2E7DB5", "E08A1E", "4F8F33", "A876F0", "B42318", "0E9384", "C11574"]
CORES_CAT = {"JOGO": "2F6B1C", "SHOW": "8D0DE3", "PROJETO ESPECIAL": "A876F0"}
LINHA = Border(bottom=Side(style="thin", color="E4D9F2"))


def _txt(sz, rot=None, cor="4E4459"):
    """Texto de eixo / legenda / rótulo do gráfico (tamanho em centésimos de ponto)."""
    return RichText(bodyPr=RichTextProperties(rot=rot, vert="horz") if rot else RichTextProperties(),
                    p=[Paragraph(pPr=ParagraphProperties(defRPr=CharacterProperties(sz=sz, solidFill=cor)), endParaRPr=CharacterProperties(sz=sz))])


# ----------------------------------------------------------------------------- fórmulas que seguem os filtros
def _rng(aba, col, r1, r2):
    return f"'{aba}'!${col}${r1}:${col}${r2}"


def _vis(aba, col, r1, r2, funcao=109):
    """Vetor com o valor de cada linha VISÍVEL (linhas escondidas pelo filtro valem 0)."""
    return f"SUBTOTAL({funcao},OFFSET('{aba}'!${col}${r1},ROW({_rng(aba, col, r1, r2)})-ROW('{aba}'!${col}${r1}),0))"


def _soma_se(aba, col_valor, r1, r2, criterios):
    """SOMA dos visíveis com critérios [(coluna, célula ou valor)]."""
    crit = "".join(f"*({_rng(aba, c, r1, r2)}={v})" for c, v in criterios)
    return f"=SUMPRODUCT({_vis(aba, col_valor, r1, r2)}{crit})"


def _conta_se(aba, col_nao_vazia, r1, r2, criterios):
    crit = "".join(f"*({_rng(aba, c, r1, r2)}={v})" for c, v in criterios)
    return f"=SUMPRODUCT({_vis(aba, col_nao_vazia, r1, r2, 103)}{crit})"


# ----------------------------------------------------------------------------- desenho do painel
class Painel:
    def __init__(self, wb, titulo, sub, filtros):
        self.ws = wb.active
        self.ws.title = "PAINEL"
        ws = self.ws
        ws.sheet_view.showGridLines = False
        _faixa(ws, 16, titulo, sub)
        ws.cell(4, 1, "Filtros da tela: " + (filtros or "nenhum")).font = Font(name=FONTE, size=10, color=ROXO_900)
        ws.cell(5, 1, "Os números e gráficos deste painel seguem os filtros das tabelas de dados: filtre por mês, categoria, "
                      "evento, item... na aba de dados e volte aqui.").font = Font(name=FONTE, size=9, italic=True, color="6B6378")
        for c, w in zip("ABCDEFGHIJKLMNOPQRST", [36, 17, 17, 17, 17, 17, 3] + [11] * 13):
            ws.column_dimensions[c].width = w
        self.lin = 7
        self.kcol = 1

    def kpis(self, lista):
        """[(rótulo, fórmula, formato)]: um indicador por linha (rótulo em A, valor em B:C)."""
        ws, r = self.ws, self.lin
        ws.cell(r, 1, "Indicadores").font = Font(name=FONTE, size=12, bold=True, color=ROXO_1000)
        for k, (rot, form, fmt) in enumerate(lista, r + 1):
            a = ws.cell(k, 1, rot)
            a.font = Font(name=FONTE, size=11, bold=True, color="FFFFFF" if k == r + 1 else ROXO_900)
            a.fill = PatternFill("solid", fgColor=ROXO if k == r + 1 else ROXO_100)
            a.alignment = Alignment(vertical="center", indent=1)
            ws.merge_cells(start_row=k, start_column=2, end_row=k, end_column=3)
            v = ws.cell(k, 2, form)
            v.font = Font(name=FONTE, size=14, bold=True, color="FFFFFF" if k == r + 1 else ROXO_1000)
            v.fill = PatternFill("solid", fgColor=ROXO if k == r + 1 else ROXO_100)
            v.number_format = fmt
            v.alignment = Alignment(horizontal="right", vertical="center")
            ws.row_dimensions[k].height = 24
        self.lin = r + len(lista) + 3

    def bloco(self, titulo, cabecalho, linhas, formatos, grafico=None, nota=None):
        """Tabela de resumo (col. A em diante) + gráfico à direita. linhas: valores ou fórmulas.
        grafico: dict(tipo='bar'|'barh'|'col_empilhada'|'linha', series=[índices de coluna (1 = 2ª coluna)], titulo, cores)."""
        ws, r = self.ws, self.lin
        ws.cell(r, 1, titulo).font = Font(name=FONTE, size=12, bold=True, color=ROXO_1000)
        if nota:
            ws.cell(r + 1, 1, nota).font = Font(name=FONTE, size=9, color="6B6378")
        h = r + 2
        for j, t in enumerate(cabecalho, 1):
            c = ws.cell(h, j, t)
            c.font = Font(name=FONTE, size=9, bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor=ROXO)
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws.row_dimensions[h].height = 28
        for i, lin in enumerate(linhas, h + 1):
            for j, v in enumerate(lin, 1):
                c = ws.cell(i, j, v)
                c.font = Font(name=FONTE, size=10, color=ROXO_1000)
                c.border = LINHA
                if formatos[j - 1]:
                    c.number_format = formatos[j - 1]
        fim = h + len(linhas)
        if grafico and linhas:
            g = grafico
            tipo = g.get("tipo", "bar")
            n = len(linhas)
            if tipo == "linha":
                ch = LineChart()
            else:
                ch = BarChart()
                ch.type = "bar" if tipo == "barh" else "col"
                if tipo == "col_empilhada":
                    ch.grouping = "stacked"; ch.overlap = 100
                ch.gapWidth = 50
            ch.title = g.get("titulo", titulo)
            ch.title.tx.rich.p[0].pPr = ParagraphProperties(defRPr=CharacterProperties(sz=1200, b=True, solidFill=ROXO_1000))
            ch.style = 10
            ch.roundedCorners = False
            if len(g["series"]) > 1:
                ch.legend.position = "b"
                ch.legend.txPr = _txt(900)
            else:
                ch.legend = None
            for k, sc in enumerate(g["series"]):
                ch.add_data(Reference(ws, min_col=sc + 1, min_row=h, max_row=fim), titles_from_data=True)
                sr = ch.series[-1]
                cor = (g.get("cores") or CORES)[k % len(g.get("cores") or CORES)]
                if tipo == "linha":
                    sr.graphicalProperties.line.solidFill = cor
                    sr.graphicalProperties.line.width = 28000
                    sr.smooth = False
                else:
                    sr.graphicalProperties.solidFill = cor
                    sr.graphicalProperties.line.solidFill = cor
            ch.set_categories(Reference(ws, min_col=1, min_row=h + 1, max_row=fim))
            # eixos: letra 9, valores em R$ sem centavos, meses inclinados quando são muitos
            ch.x_axis.txPr = _txt(900, rot=-2700000 if (tipo != "barh" and n > 8) else None)
            ch.y_axis.txPr = _txt(900)
            ch.y_axis.number_format = g.get("fmt_eixo", '"R$" #,##0')
            ch.y_axis.numFmt.sourceLinked = False
            ch.y_axis.majorGridlines.spPr = GraphicalProperties(ln=LineProperties(solidFill="E9E1F3"))
            ch.x_axis.delete = False; ch.y_axis.delete = False
            ch.x_axis.majorTickMark = "none"; ch.y_axis.majorTickMark = "none"
            if tipo == "barh":
                ch.x_axis.scaling.orientation = "maxMin"      # o maior em cima
                ch.y_axis.crosses = "max"                       # valores embaixo, mesmo com o eixo invertido
            if len(g["series"]) == 1 and n <= (12 if tipo == "barh" else 8):
                ch.dataLabels = DataLabelList(); ch.dataLabels.showVal = True
                ch.dataLabels.showSerName = False; ch.dataLabels.showCatName = False; ch.dataLabels.showLegendKey = False; ch.dataLabels.showPercent = False
                ch.dataLabels.txPr = _txt(800)
                ch.dataLabels.numFmt = g.get("fmt_rotulo", '"R$" #,##0')
                ch.dataLabels.position = "outEnd"
            if tipo == "barh":
                ch.height = max(6.5, 2.2 + n * 0.75)
            else:
                ch.height = 9.5 if n > 8 else 8
            ch.width = 24 if (tipo != "barh" and n > 12) else 20
            col = get_column_letter(len(cabecalho) + 2)
            ws.add_chart(ch, f"{col}{r}")
            altura_linhas = int(ch.height / 0.53) + 3
        else:
            altura_linhas = 0
        self.lin = max(fim + 3, r + altura_linhas)


def _dados(wb, aba, titulo, sub, cab, linhas, formatos, larguras, nome_tabela):
    ws = wb.create_sheet(aba)
    _faixa(ws, len(cab), titulo, sub)
    _tabela(ws, nome_tabela, cab, linhas, formatos, larguras)
    return 5, 4 + max(len(linhas), 1)


def _dinamica(wb, aba, titulo, dica, origem, cab, lin, linhas_campos, valores, filtros, nome):
    """Aba com uma tabela dinâmica de verdade (Inserir > Tabela dinâmica), já montada."""
    ws = wb.create_sheet(aba)
    _faixa(ws, 8, titulo, dica)
    ws.sheet_view.showGridLines = False
    c = ws.cell(3, 1, "Clique no + / − para abrir e fechar cada grupo (como as listas do site) · use os filtros do topo · "
                      "botão direito > Mostrar lista de campos para montar do seu jeito. Se aparecer vazia, clique em Habilitar Edição.")
    c.font = Font(name=FONTE, size=9, italic=True, color="6B6378")
    ws.row_dimensions[3].height = 18
    ws.column_dimensions["A"].width = 58
    for col in "BCDEFG":
        ws.column_dimensions[col].width = 18
    pivo.criar(ws, origem, cab, lin, 4, linhas_campos, valores, filtros=filtros, nome=nome, ancora_linha=5)
    return ws


def _anomes(data):
    return (data or "")[:7]


def _mes(data):
    d = _d(data)
    return dt.date(d.year, d.month, 1) if d else None


def _top(contagem, n):
    return [k for k, _ in sorted(contagem.items(), key=lambda x: -x[1])[:n]]


# ----------------------------------------------------------------------------- páginas
def _eventos(con, ids):
    evs = calculos.eventos_com_totais(con)
    return [e for e in evs if ids is None or e["id"] in ids]


def avarias(con, ids, q, filtros):
    evs = {e["id"]: e for e in _eventos(con, ids)}
    rows = db.rows(con.execute("SELECT * FROM itens WHERE tipo='AVARIAS' ORDER BY evento_id, item"))
    qn = (q or "").strip().upper()
    itens = []
    for i in rows:
        e = evs.get(i["evento_id"])
        if not e:
            continue
        if qn and qn not in f"{i['item']} {e['nome']} {e['data']}".upper():
            continue
        itens.append((e, i))
    itens.sort(key=lambda x: (x[0]["data"], x[0]["nome"], x[1]["item"]), reverse=True)
    wb = Workbook()
    p = Painel(wb, "Avarias", f"Central de Engenharia · exportado em {dt.datetime.now():%d/%m/%Y %H:%M}", filtros)
    cab = ["DATA", "MÊS", "ANO", "CATEGORIA", "GÊNERO", "EVENTO", "ITEM", "VALOR UNIT. (R$)", "QTD.", "TOTAL (R$)", "EVENTO · DATA", "ANO-MÊS"]
    lin = [[_d(e["data"]), _mes(e["data"]), int(e["data"][:4]), e["categoria"] or "SEM CATEGORIA", e["genero"] or "", e["nome"], i["item"],
            i["valor_unit"], i["qtd"], round((i["valor_unit"] or 0) * (i["qtd"] or 0), 2), f"{e['nome']} · {_d(e['data']):%d/%m/%y}",
            _anomes(e["data"])] for e, i in itens]
    A = "AVARIAS"
    r1, r2 = _dados(wb, A, "Avarias · lista completa", "Uma linha por item avariado em cada evento · use os filtros do cabeçalho",
                    cab, lin, [DATA, MES, "0", None, None, None, None, BRL, NUM, BRL, None, None], [12, 10, 7, 18, 16, 30, 46, 15, 8, 15, 36, 10], "tbAvarias")
    _dinamica(wb, "DINÂMICA POR ITEM", "Tabela dinâmica · por item", "Cada item abre a lista dos eventos em que foi avariado", A, cab, lin,
              [6, 10], [(9, "sum", "Valor (R$)"), (8, "sum", "Qtd.")], [3, 11, 4], "tdAvariasItem")
    _dinamica(wb, "DINÂMICA POR EVENTO", "Tabela dinâmica · por evento", "Cada evento abre a lista dos itens avariados", A, cab, lin,
              [10, 6], [(9, "sum", "Valor (R$)"), (8, "sum", "Qtd.")], [3, 11, 4], "tdAvariasEvento")
    p.kpis([("Valor total de avarias", f"=SUBTOTAL(109,'{A}'!$J${r1}:$J${r2})", BRL),
            ("Itens avariados (qtd.)", f"=SUBTOTAL(109,'{A}'!$I${r1}:$I${r2})", INT),
            ("Lançamentos", f"=SUBTOTAL(103,'{A}'!$F${r1}:$F${r2})", INT),
            ("Valor médio por lançamento", f"=IFERROR(SUBTOTAL(109,'{A}'!$J${r1}:$J${r2})/SUBTOTAL(103,'{A}'!$F${r1}:$F${r2}),0)", BRL)])
    meses = sorted({l[1] for l in lin if l[1]})
    p.bloco("Avarias por mês", ["MÊS", "VALOR (R$)", "QTD."],
            [[m, _soma_se(A, "J", r1, r2, [("B", f"$A${p.lin + 3 + k}")]), _soma_se(A, "I", r1, r2, [("B", f"$A${p.lin + 3 + k}")])] for k, m in enumerate(meses)],
            [MES, BRL, INT], {"tipo": "col", "series": [1], "titulo": "Valor de avarias por mês"})
    cats = sorted({l[3] for l in lin})
    p.bloco("Por categoria", ["CATEGORIA", "VALOR (R$)", "QTD."],
            [[c, _soma_se(A, "J", r1, r2, [("D", f"$A${p.lin + 3 + k}")]), _soma_se(A, "I", r1, r2, [("D", f"$A${p.lin + 3 + k}")])] for k, c in enumerate(cats)],
            [None, BRL, INT], {"tipo": "barh", "series": [1], "titulo": "Valor por categoria", "rotulos": True})
    tot_item, tot_ev = {}, {}
    for l in lin:
        tot_item[l[6]] = tot_item.get(l[6], 0) + l[9]
        tot_ev[l[10]] = tot_ev.get(l[10], 0) + l[9]
    top_i = _top(tot_item, 15)
    p.bloco("Os 15 itens de maior valor", ["ITEM", "VALOR (R$)", "QTD."],
            [[it, _soma_se(A, "J", r1, r2, [("G", f"$A${p.lin + 3 + k}")]), _soma_se(A, "I", r1, r2, [("G", f"$A${p.lin + 3 + k}")])] for k, it in enumerate(top_i)],
            [None, BRL, INT], {"tipo": "barh", "series": [1], "titulo": "Itens de maior valor"}, nota="lista dos 15 maiores no momento da exportação; os valores seguem os filtros")
    top_e = _top(tot_ev, 15)
    p.bloco("Os 15 eventos com mais avarias", ["EVENTO · DATA", "VALOR (R$)", "QTD."],
            [[ev, _soma_se(A, "J", r1, r2, [("K", f"$A${p.lin + 3 + k}")]), _soma_se(A, "I", r1, r2, [("K", f"$A${p.lin + 3 + k}")])] for k, ev in enumerate(top_e)],
            [None, BRL, INT], {"tipo": "barh", "series": [1], "titulo": "Eventos com mais avarias"})
    # resumos prontos (com filtro)
    pi = {}
    for l in lin:
        x = pi.setdefault(l[6], {"ev": set(), "q": 0, "v": 0})
        x["ev"].add(l[10]); x["q"] += l[8] or 0; x["v"] += l[9]
    _dados(wb, "POR ITEM", "Avarias por item", "Soma de todos os eventos exportados", ["ITEM", "EVENTOS", "QTD.", "VALOR TOTAL (R$)", "VALOR MÉDIO POR EVENTO (R$)"],
           sorted([[k, len(x["ev"]), x["q"], round(x["v"], 2), round(x["v"] / len(x["ev"]), 2)] for k, x in pi.items()], key=lambda r: -r[3]),
           [None, INT, NUM, BRL, BRL], [50, 10, 10, 18, 18], "tbPorItem")
    pe = {}
    for l in lin:
        x = pe.setdefault(l[10], {"l": l, "n": set(), "q": 0, "v": 0})
        x["n"].add(l[6]); x["q"] += l[8] or 0; x["v"] += l[9]
    _dados(wb, "POR EVENTO", "Avarias por evento", "Um evento por linha", ["DATA", "MÊS", "CATEGORIA", "GÊNERO", "EVENTO", "TIPOS DE ITEM", "QTD.", "VALOR TOTAL (R$)"],
           sorted([[x["l"][0], x["l"][1], x["l"][3], x["l"][4], x["l"][5], len(x["n"]), x["q"], round(x["v"], 2)] for x in pe.values()], key=lambda r: r[0] or dt.date.min, reverse=True),
           [DATA, MES, None, None, None, INT, NUM, BRL], [12, 10, 18, 16, 34, 12, 10, 18], "tbPorEvento")
    return _fim(wb)


def manutencao(con, ids, q, filtros):
    evs = {e["id"]: e for e in _eventos(con, ids)}
    rows = db.rows(con.execute("SELECT * FROM chamados ORDER BY evento_id, hora_inicio"))
    qn = (q or "").strip().upper()
    lin = []
    for c in rows:
        e = evs.get(c["evento_id"])
        if not e or (qn and qn not in f"{e['nome']} {c['descricao']} {c['tipo']}".upper()):
            continue
        t = calculos.minutos(c["hora_inicio"], c["hora_final"])
        hora = int(c["hora_inicio"][:2]) if (c["hora_inicio"] or "")[:2].isdigit() else None
        lin.append([_d(e["data"]), _mes(e["data"]), e["categoria"] or "SEM CATEGORIA", e["genero"] or "", e["nome"], c["tipo"] or "SEM TIPO",
                    c["descricao"], c["hora_inicio"], c["hora_final"], hora, t, (1 if t <= calculos.SLA_MINUTOS else 0) if t is not None else None,
                    f"{e['nome']} · {_d(e['data']):%d/%m/%y}", _anomes(e["data"])])
    lin.sort(key=lambda r: (r[0] or dt.date.min, r[7] or ""), reverse=True)
    wb = Workbook()
    p = Painel(wb, "Manutenção · chamados", f"Central de Engenharia · SLA de {calculos.SLA_MINUTOS} min · exportado em {dt.datetime.now():%d/%m/%Y %H:%M}", filtros)
    C = "CHAMADOS"
    cab = ["DATA", "MÊS", "CATEGORIA", "GÊNERO", "EVENTO", "TIPO", "DESCRIÇÃO", "INÍCIO", "FIM", "HORA", "TEMPO (MIN)", "DENTRO DO SLA", "EVENTO · DATA", "ANO-MÊS"]
    r1, r2 = _dados(wb, C, "Chamados · lista completa", f"Tempo = abertura até a execução · SLA = até {calculos.SLA_MINUTOS} min",
                    cab, lin, [DATA, MES, None, None, None, None, None, None, None, "0", INT, SIMNAO, None, None],
                    [12, 10, 18, 16, 30, 20, 60, 9, 9, 7, 12, 13, 36, 10], "tbChamados")
    _dinamica(wb, "DINÂMICA POR TIPO", "Tabela dinâmica · chamados por tipo", "Cada tipo abre a lista dos eventos", C, cab, lin,
              [5, 12], [(4, "count", "Chamados"), (10, "average", "Tempo médio (min)")], [2, 13, 3], "tdChamadosTipo")
    _dinamica(wb, "DINÂMICA POR EVENTO", "Tabela dinâmica · chamados por evento", "Cada evento abre a lista por tipo", C, cab, lin,
              [12, 5], [(4, "count", "Chamados"), (10, "average", "Tempo médio (min)")], [2, 13, 3], "tdChamadosEvento")
    p.kpis([("Chamados", f"=SUBTOTAL(103,'{C}'!$E${r1}:$E${r2})", INT),
            ("Tempo médio (min)", f"=IFERROR(SUBTOTAL(101,'{C}'!$K${r1}:$K${r2}),0)", NUM),
            ("Dentro do SLA", f"=IFERROR(SUBTOTAL(109,'{C}'!$L${r1}:$L${r2})/SUBTOTAL(102,'{C}'!$K${r1}:$K${r2}),0)", PCT),
            ("Tempo máximo (min)", f"=IFERROR(SUBTOTAL(104,'{C}'!$K${r1}:$K${r2}),0)", INT)])
    cont_t = {}
    for l in lin:
        cont_t[l[5]] = cont_t.get(l[5], 0) + 1
    tipos = _top(cont_t, 50)
    b = p.lin
    p.bloco("Chamados por tipo", ["TIPO", "CHAMADOS", "TEMPO MÉDIO (MIN)"],
            [[t, _conta_se(C, "E", r1, r2, [("F", f"$A${b + 3 + k}")]),
              f"=IFERROR(SUMPRODUCT({_vis(C, 'K', r1, r2)}*({_rng(C, 'F', r1, r2)}=$A${b + 3 + k}))/SUMPRODUCT({_vis(C, 'K', r1, r2, 102)}*({_rng(C, 'F', r1, r2)}=$A${b + 3 + k})),0)"]
             for k, t in enumerate(tipos)], [None, INT, NUM], {"tipo": "barh", "series": [1], "titulo": "Chamados por tipo", "fmt_eixo": "#,##0", "fmt_rotulo": "#,##0"})
    b = p.lin
    p.bloco("Tempo médio por tipo", ["TIPO", "TEMPO MÉDIO (MIN)"],
            [[t, f"=IFERROR(SUMPRODUCT({_vis(C, 'K', r1, r2)}*({_rng(C, 'F', r1, r2)}=$A${b + 3 + k}))/SUMPRODUCT({_vis(C, 'K', r1, r2, 102)}*({_rng(C, 'F', r1, r2)}=$A${b + 3 + k})),0)"]
             for k, t in enumerate(tipos)], [None, NUM], {"tipo": "barh", "series": [1], "titulo": "Tempo médio de atendimento (min)", "cores": ["E08A1E"], "fmt_eixo": "#,##0", "fmt_rotulo": "#,##0.0"})
    b = p.lin
    p.bloco("Chamados por hora do dia", ["HORA", "CHAMADOS"],
            [[f"{h:02d}h", _conta_se(C, "E", r1, r2, [("J", h)])] for h in range(24)], [None, INT],
            {"tipo": "col", "series": [1], "titulo": "Chamados abertos em cada hora", "fmt_eixo": "#,##0"})
    cont = {}
    for l in lin:
        cont[l[12]] = cont.get(l[12], 0) + 1
    b = p.lin
    p.bloco("Os 20 eventos com mais chamados", ["EVENTO · DATA", "CHAMADOS"],
            [[ev, _conta_se(C, "E", r1, r2, [("M", f"$A${b + 3 + k}")])] for k, ev in enumerate(_top(cont, 20))], [None, INT],
            {"tipo": "barh", "series": [1], "titulo": "Eventos com mais chamados", "fmt_eixo": "#,##0", "fmt_rotulo": "#,##0"})
    pt = {}
    for l in lin:
        x = pt.setdefault(l[5], {"n": 0, "t": [], "s": 0})
        x["n"] += 1
        if l[10] is not None:
            x["t"].append(l[10]); x["s"] += l[11] or 0
    _dados(wb, "POR TIPO", "Chamados por tipo", "Quantidade, tempo médio e SLA", ["TIPO", "CHAMADOS", "TEMPO MÉDIO (MIN)", "TEMPO MÁXIMO (MIN)", "DENTRO DO SLA (%)"],
           sorted([[k, x["n"], round(sum(x["t"]) / len(x["t"]), 1) if x["t"] else None, max(x["t"]) if x["t"] else None,
                    round(x["s"] / len(x["t"]), 4) if x["t"] else None] for k, x in pt.items()], key=lambda r: -r[1]),
           [None, INT, NUM, INT, PCT], [30, 12, 16, 16, 16], "tbPorTipo")
    return _fim(wb)


def visao(con, ids, q, filtros, titulo="Visão geral"):
    evs = _eventos(con, ids)
    qn = (q or "").strip().upper()
    if qn:
        evs = [e for e in evs if qn in f"{e['nome']} {e['genero']} {e['categoria']}".upper()]
    evs.sort(key=lambda e: (e["data"], e["nome"]), reverse=True)
    idset = {e["id"] for e in evs}
    por_id = {e["id"]: e for e in evs}
    wb = Workbook()
    p = Painel(wb, titulo, f"Central de Engenharia · custos por evento · exportado em {dt.datetime.now():%d/%m/%Y %H:%M}", filtros)
    E = "EVENTOS"
    cab = ["DATA", "MÊS", "ANO", "CATEGORIA", "GÊNERO", "EVENTO", "MDO (R$)", "AVARIAS (R$)", "INSUMOS (R$)", "ÁGUA (R$)", "DOS QUAIS IRRIGAÇÃO (R$)",
           "GÁS (R$)", "ENERGIA (R$)", "POÇO (R$)", "MEDIDORES (R$)", "TOTAL (R$)", "CHAMADOS", "TEMPO MÉDIO (MIN)", "EVENTO · DATA", "ANO-MÊS"]
    lin = [[_d(e["data"]), _mes(e["data"]), int(e["data"][:4]), e["categoria"] or "SEM CATEGORIA", e["genero"] or "", e["nome"], e["mdo"], e["avarias"],
            e["insumos"], e["agua"], e["irrigacao"] or None, e["gas"], e["eletrica"], e["poco"], e["relogios"], e["total"], e["n_chamados"], e["tempo_medio"],
            f"{e['nome']} · {_d(e['data']):%d/%m/%y}", _anomes(e["data"])] for e in evs]
    r1, r2 = _dados(wb, E, "Eventos", "Um evento por linha · a irrigação já está dentro da água", cab, lin,
                    [DATA, MES, "0", None, None, None] + [BRL] * 10 + [INT, NUM, None, None], [12, 10, 7, 18, 18, 32] + [14] * 10 + [10, 12, 36, 10], "tbEventos")
    _dinamica(wb, "DINÂMICA EVENTOS", "Tabela dinâmica · custo dos eventos", "Cada categoria abre a lista dos eventos", E, cab, lin,
              [3, 18], [(15, "sum", "Total (R$)"), (14, "sum", "Medidores (R$)"), (6, "sum", "MDO (R$)"), (7, "sum", "Avarias (R$)")],
              [4, 19], "tdEventos")
    p.kpis([("Custo total", f"=SUBTOTAL(109,'{E}'!$P${r1}:$P${r2})", BRL),
            ("Eventos", f"=SUBTOTAL(103,'{E}'!$F${r1}:$F${r2})", INT),
            ("Média por evento", f"=IFERROR(SUBTOTAL(109,'{E}'!$P${r1}:$P${r2})/SUBTOTAL(103,'{E}'!$F${r1}:$F${r2}),0)", BRL),
            ("Mão de obra (MDO)", f"=SUBTOTAL(109,'{E}'!$G${r1}:$G${r2})", BRL),
            ("Avarias", f"=SUBTOTAL(109,'{E}'!$H${r1}:$H${r2})", BRL),
            ("Medidores", f"=SUBTOTAL(109,'{E}'!$O${r1}:$O${r2})", BRL)])
    meses = sorted({l[1] for l in lin if l[1]})
    b = p.lin
    p.bloco("Custo por mês, por componente", ["MÊS", "MEDIDORES", "MDO", "AVARIAS", "INSUMOS", "TOTAL"],
            [[m] + [_soma_se(E, c, r1, r2, [("B", f"$A${b + 3 + k}")]) for c in "OGHIP"] for k, m in enumerate(meses)],
            [MES, BRL, BRL, BRL, BRL, BRL], {"tipo": "col_empilhada", "series": [1, 2, 3, 4], "titulo": "Custo por mês",
                                             "cores": ["4F8F33", "8D0DE3", "E08A1E", "2E7DB5"]})
    cats = sorted({l[3] for l in lin})
    b = p.lin
    p.bloco("Por categoria", ["CATEGORIA", "EVENTOS", "CUSTO TOTAL (R$)", "MÉDIA POR EVENTO (R$)"],
            [[c, _conta_se(E, "F", r1, r2, [("D", f"$A${b + 3 + k}")]), _soma_se(E, "P", r1, r2, [("D", f"$A${b + 3 + k}")]),
              f"=IFERROR(C{b + 3 + k}/B{b + 3 + k},0)"] for k, c in enumerate(cats)],
            [None, INT, BRL, BRL], {"tipo": "barh", "series": [3], "titulo": "Média por evento, por categoria", "rotulos": True})
    b = p.lin
    comps = [("Água", "J"), ("Energia", "M"), ("Gás", "L"), ("Poço", "N"), ("MDO", "G"), ("Avarias", "H"), ("Insumos", "I")]
    p.bloco("Total por componente", ["COMPONENTE", "VALOR (R$)"], [[n, f"=SUBTOTAL(109,'{E}'!${c}${r1}:${c}${r2})"] for n, c in comps],
            [None, BRL], {"tipo": "barh", "series": [1], "titulo": "Total por componente", "rotulos": True})
    tot = {l[18]: l[15] or 0 for l in lin}
    b = p.lin
    p.bloco("Os 15 eventos de maior custo", ["EVENTO · DATA", "TOTAL (R$)"],
            [[ev, _soma_se(E, "P", r1, r2, [("S", f"$A${b + 3 + k}")])] for k, ev in enumerate(_top(tot, 15))], [None, BRL],
            {"tipo": "barh", "series": [1], "titulo": "Eventos de maior custo"})
    # itens, medidores, chamados e energia dos mesmos eventos
    itens = [i for i in db.rows(con.execute("SELECT * FROM itens ORDER BY evento_id, tipo, item")) if i["evento_id"] in idset]
    cab_i = ["DATA", "MÊS", "CATEGORIA", "GÊNERO", "EVENTO", "TIPO", "ITEM", "VALOR UNIT. (R$)", "QTD.", "TOTAL (R$)", "EVENTO · DATA", "ANO-MÊS"]
    lin_i = []
    for i in itens:
        e = por_id[i["evento_id"]]
        lin_i.append([_d(e["data"]), _mes(e["data"]), e["categoria"] or "SEM CATEGORIA", e["genero"] or "", e["nome"], i["tipo"], i["item"], i["valor_unit"],
                      i["qtd"], round((i["valor_unit"] or 0) * (i["qtd"] or 0), 2), f"{e['nome']} · {_d(e['data']):%d/%m/%y}", _anomes(e["data"])])
    _dados(wb, "ITENS", "Itens de custo", "Avarias, MDO e insumos de cada evento", cab_i, lin_i,
           [DATA, MES, None, None, None, None, None, BRL, NUM, BRL, None, None], [12, 10, 18, 16, 30, 11, 46, 15, 8, 15, 36, 10], "tbItens")
    if lin_i:
        _dinamica(wb, "DINÂMICA ITENS", "Tabela dinâmica · itens de custo", "Tipo (avarias, MDO, insumos) > item > evento", "ITENS", cab_i, lin_i,
                  [5, 6, 10], [(9, "sum", "Total (R$)"), (8, "sum", "Qtd.")], [2, 11], "tdItens")
    rel = [r for r in db.rows(con.execute("SELECT * FROM relogios ORDER BY evento_id, tipo")) if r["evento_id"] in idset]
    _dados(wb, "MEDIDORES", "Medidores de consumo", "Água, gás e poço em m³ · energia em kWh · irrigação: parte da água",
           ["DATA", "CATEGORIA", "EVENTO", "MEDIDOR", "CONSUMO", "UNIDADE", "VALOR (R$)"],
           [[_d(por_id[r["evento_id"]]["data"]), por_id[r["evento_id"]]["categoria"] or "SEM CATEGORIA", por_id[r["evento_id"]]["nome"],
             r["tipo"] + (" (já na água)" if r["tipo"] == "IRRIGAÇÃO" else ""), r["consumo"], "kWh" if r["tipo"] == "ELÉTRICA" else "m³", r["valor"]] for r in rel],
           [DATA, None, None, None, NUM, None, BRL], [12, 18, 30, 26, 12, 9, 15], "tbMedidores")
    chs = [c for c in db.rows(con.execute("SELECT * FROM chamados ORDER BY evento_id, hora_inicio")) if c["evento_id"] in idset]
    if chs:
        lc = []
        for c in chs:
            t = calculos.minutos(c["hora_inicio"], c["hora_final"])
            e = por_id[c["evento_id"]]
            lc.append([_d(e["data"]), e["categoria"] or "SEM CATEGORIA", e["nome"], c["tipo"], c["descricao"], c["hora_inicio"], c["hora_final"], t,
                       (1 if t <= calculos.SLA_MINUTOS else 0) if t is not None else None])
        _dados(wb, "CHAMADOS", "Chamados de manutenção", f"SLA = até {calculos.SLA_MINUTOS} min",
               ["DATA", "CATEGORIA", "EVENTO", "TIPO", "DESCRIÇÃO", "INÍCIO", "FIM", "TEMPO (MIN)", "DENTRO DO SLA"], lc,
               [DATA, None, None, None, None, None, None, INT, SIMNAO], [12, 18, 30, 20, 60, 9, 9, 12, 13], "tbChamados")
    if len(evs) <= 2:   # um evento (ou comparação): curva de energia por hora
        en = [r for r in db.rows(con.execute("SELECT * FROM energia_hora ORDER BY evento_id, ordem")) if r["evento_id"] in idset]
        if en:
            ws_e = wb.create_sheet("ENERGIA POR HORA")
            _faixa(ws_e, 6, "Energia por hora", "Consumo elétrico (kWh) hora a hora")
            _tabela(ws_e, "tbEnergia", ["EVENTO", "ORDEM", "DATA", "HORA", "CONSUMO (KWH)"],
                    [[por_id[r["evento_id"]]["nome"], r["ordem"], _d(r["data_consumo"]), r["hora"], r["consumo"]] for r in en],
                    [None, INT, DATA, None, NUM], [30, 8, 12, 9, 15])
            ch = LineChart(); ch.title = "Energia por hora (kWh)"; ch.height = 9; ch.width = 22; ch.legend = None
            ch.add_data(Reference(ws_e, min_col=5, min_row=4, max_row=4 + len(en)), titles_from_data=True)
            ch.set_categories(Reference(ws_e, min_col=4, min_row=5, max_row=4 + len(en)))
            ch.series[0].graphicalProperties.line.solidFill = ROXO
            ws_e.add_chart(ch, "H4")
    return _fim(wb)


def _fim(wb):
    for w in wb.worksheets:
        w.sheet_properties.tabColor = ROXO if w.title != "PAINEL" else VERDE_900
        w.page_setup.orientation = "landscape"
        w.page_setup.fitToWidth = 1
        w.page_setup.fitToHeight = 0
        w.sheet_properties.pageSetUpPr.fitToPage = True
    wb.active = 0
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def gerar(pagina, ids, q="", filtros=""):
    with db.connect() as con:
        if pagina == "avarias":
            return avarias(con, ids, q, filtros), "AVARIAS"
        if pagina == "manutencao":
            return manutencao(con, ids, q, filtros), "MANUTENCAO"
        if pagina == "evento":
            return visao(con, ids, "", filtros, "Evento"), "EVENTO"
        if pagina == "comparar":
            return visao(con, ids, "", filtros, "Comparação de eventos"), "COMPARACAO"
        return visao(con, ids, q, filtros), "VISAO GERAL"
