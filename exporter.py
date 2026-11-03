"""Gera o novo modelo Excel (.xlsx) a partir do banco do site.

Cada aba tem uma Tabela do Excel com nome fixo (tbEventos, tbItens, ...). O Power BI deve
apontar para essas tabelas. Os valores são gravados como números (sem fórmulas), para que o
Power BI leia tudo mesmo sem o arquivo ter sido aberto no Excel.
"""
import datetime as dt
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

import db
import calculos

ROXO = "8D0DE3"
ROXO_900 = "420465"
ROXO_1000 = "1E002F"
ROXO_100 = "ECDFFF"
VERDE_200 = "C9E2BF"
VERDE_900 = "174006"
CINZA = "6B6378"

FONTE = "Calibri"
BRL = '"R$" #,##0.00;[Red]-"R$" #,##0.00'
NUM = '#,##0.00'
INT = '#,##0'
DATA = 'dd/mm/yyyy'


def _d(s):
    try:
        return dt.date.fromisoformat(s) if s else None
    except ValueError:
        return None


def _faixa(ws, ncols, titulo, subtitulo):
    """Cabeçalho visual: faixa roxa com título + linha de subtítulo + blocos decorativos."""
    for c in range(1, ncols + 1):
        ws.cell(1, c).fill = PatternFill("solid", fgColor=ROXO_1000)
        ws.cell(2, c).fill = PatternFill("solid", fgColor=ROXO_1000)
    ws.row_dimensions[1].height = 30
    ws.row_dimensions[2].height = 18
    ws.cell(1, 1, titulo).font = Font(name=FONTE, size=18, bold=True, color="FFFFFF")
    ws.cell(2, 1, subtitulo).font = Font(name=FONTE, size=10, color="CBA5FD")
    ws.cell(1, 1).alignment = Alignment(vertical="center", indent=1)
    ws.cell(2, 1).alignment = Alignment(vertical="center", indent=1)
    # blocos coloridos (assinatura visual do guia de marca)
    for c, cor in zip(range(max(ncols - 2, 2), ncols + 1), (VERDE_200, ROXO, VERDE_200)):
        ws.cell(1, c).fill = PatternFill("solid", fgColor=cor)
    ws.row_dimensions[3].height = 8


def _tabela(ws, nome, cabecalho, linhas, formatos, larguras, linha_ini=4):
    ws.sheet_view.showGridLines = False
    borda = Border(bottom=Side(style="thin", color="E4D9F2"))
    for j, h in enumerate(cabecalho, 1):
        c = ws.cell(linha_ini, j, h)
        c.font = Font(name=FONTE, bold=True, color="FFFFFF", size=10)
        c.fill = PatternFill("solid", fgColor=ROXO)
        c.alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)
    ws.row_dimensions[linha_ini].height = 30
    for i, lin in enumerate(linhas, linha_ini + 1):
        for j, v in enumerate(lin, 1):
            c = ws.cell(i, j, v)
            c.font = Font(name=FONTE, size=10, color="1E002F")
            c.border = borda
            f = formatos[j - 1]
            if f:
                c.number_format = f
    for j, w in enumerate(larguras, 1):
        ws.column_dimensions[get_column_letter(j)].width = w
    fim = linha_ini + max(len(linhas), 1)
    ref = f"A{linha_ini}:{get_column_letter(len(cabecalho))}{fim}"
    t = Table(displayName=nome, ref=ref)
    t.tableStyleInfo = TableStyleInfo(name="TableStyleLight1", showRowStripes=True)
    ws.add_table(t)
    ws.freeze_panes = ws.cell(linha_ini + 1, 1)


def gerar_excel():
    with db.connect() as con:
        eventos = calculos.eventos_com_totais(con)
        ev = {e["id"]: e for e in eventos}
        itens = db.rows(con.execute("SELECT * FROM itens ORDER BY evento_id, tipo, item"))
        rel = db.rows(con.execute("SELECT * FROM relogios ORDER BY evento_id, tipo"))
        ch = db.rows(con.execute("SELECT * FROM chamados ORDER BY evento_id, hora_inicio"))
        en = db.rows(con.execute("SELECT * FROM energia_hora ORDER BY evento_id, ordem"))
        cat = db.rows(con.execute("SELECT * FROM catalogo ORDER BY tipo, item"))

    wb = Workbook()
    hoje = dt.datetime.now().strftime("%d/%m/%Y %H:%M")

    # LEIA-ME --------------------------------------------------------------
    ws = wb.active
    ws.title = "LEIA-ME"
    _faixa(ws, 8, "Relatório de eventos", f"Central de Engenharia · Engenharia & Infraestrutura · exportado em {hoje}")
    ws.sheet_view.showGridLines = False
    texto = [
        ("Como esta planilha funciona", True),
        ("Este arquivo é gerado pela Central de Engenharia (área Relatório de eventos). Cada aba tem uma Tabela do Excel com nome fixo.", False),
        ("O Power BI deve se conectar às tabelas abaixo (Obter dados > Excel > marcar as tabelas 'tb...').", False),
        ("", False),
        ("Tabelas", True),
        ("tbEventos  · um evento por linha (evento + data). Traz os totais já calculados: MDO, Avarias, Insumos, Medidores e Total.", False),
        ("tbItens    · itens de custo do evento (AVARIAS, MDO, INSUMOS) com valor unitário, quantidade e total.", False),
        ("tbMedidores · medidores de consumo por evento (ÁGUA, GÁS, ELÉTRICA, POÇO, IRRIGAÇÃO), consumo e valor em R$.", False),
        ("tbChamados · chamados de manutenção com tempo de atendimento (min) e status de SLA (até 60 min).", False),
        ("tbEnergia  · curva de consumo de energia por hora (kWh).", False),
        ("tbCatalogo · tabela de preços de avarias, MDO e insumos.", False),
        ("", False),
        ("Chave de relacionamento", True),
        ("Todas as tabelas têm as colunas ID EVENTO, EVENTO e DATA. Relacione pelo ID EVENTO (1 evento : N linhas).", False),
        ("", False),
        ("Atualização", True),
        ("Cadastre e edite os dados no site. Para atualizar este arquivo, use o botão 'Exportar Excel' no site e salve por cima.", False),
    ]
    for i, (t, negrito) in enumerate(texto, 5):
        c = ws.cell(i, 1, t)
        c.font = Font(name=FONTE, size=12 if negrito else 10, bold=negrito, color=ROXO if negrito else "1E002F")
    ws.column_dimensions["A"].width = 120

    # EVENTOS --------------------------------------------------------------
    ws = wb.create_sheet("EVENTOS")
    cab = ["ID EVENTO", "EVENTO", "DATA", "CATEGORIA", "GÊNERO", "HORÁRIO", "PÚBLICO", "CLIENTE",
           "MDO (R$)", "AVARIAS (R$)", "INSUMOS (R$)", "ÁGUA (R$)", "GÁS (R$)", "ELÉTRICA (R$)", "POÇO (R$)",
           "IRRIGAÇÃO (R$)", "MEDIDORES (R$)", "TOTAL (R$)", "TÉCNICOS TRANSP. VERTICAL", "MEDIÇÃO ACÚSTICA (QTD)", "MEDIÇÃO ACÚSTICA (R$)", "CHAMADOS", "TEMPO MÉDIO (MIN)", "% DENTRO SLA"]
    _faixa(ws, len(cab), "Eventos", "Um evento por linha, com totais calculados")
    linhas = [[e["id"], e["nome"], _d(e["data"]), e["categoria"], e["genero"], e["horario"], e["publico"], e["cliente"],
               e["mdo"], e["avarias"], e["insumos"], e["agua"], e["gas"], e["eletrica"], e["poco"],
               e["irrigacao"], e["relogios"], e["total"], e["tecnicos_tv"], e["acustica"], e["acustica_valor"], e["n_chamados"], e["tempo_medio"],
               (e["pct_sla"] / 100 if e["pct_sla"] is not None else None)] for e in eventos]
    _tabela(ws, "tbEventos", cab, linhas,
            [INT, None, DATA, None, None, None, INT, None] + [BRL] * 10 + [INT, INT, BRL, INT, NUM, "0.0%"],
            [10, 34, 12, 18, 18, 10, 10, 16] + [14] * 10 + [14, 12, 14, 11, 12, 11])

    # ITENS ----------------------------------------------------------------
    ws = wb.create_sheet("ITENS")
    cab = ["ID EVENTO", "EVENTO", "DATA", "TIPO", "ITEM", "VALOR UNIT. (R$)", "QTD.", "TOTAL (R$)"]
    _faixa(ws, len(cab), "Itens de custo", "Avarias, mão de obra (MDO) e insumos por evento")
    linhas = []
    for i in itens:
        e = ev.get(i["evento_id"])
        if e:
            linhas.append([e["id"], e["nome"], _d(e["data"]), i["tipo"], i["item"], i["valor_unit"], i["qtd"],
                           round((i["valor_unit"] or 0) * (i["qtd"] or 0), 2)])
    _tabela(ws, "tbItens", cab, linhas, [INT, None, DATA, None, None, BRL, NUM, BRL], [10, 34, 12, 12, 56, 16, 9, 16])

    # MEDIDORES ------------------------------------------------------------
    ws = wb.create_sheet("MEDIDORES")
    cab = ["ID EVENTO", "EVENTO", "DATA", "TIPO", "CONSUMO", "VALOR (R$)"]
    _faixa(ws, len(cab), "Medidores de consumo", "Água e poço em m³ · gás em m³ · energia em kWh")
    linhas = [[ev[r["evento_id"]]["id"], ev[r["evento_id"]]["nome"], _d(ev[r["evento_id"]]["data"]), r["tipo"],
               r["consumo"], r["valor"]] for r in rel if r["evento_id"] in ev]
    _tabela(ws, "tbMedidores", cab, linhas, [INT, None, DATA, None, NUM, BRL], [10, 34, 12, 12, 14, 16])

    # CHAMADOS -------------------------------------------------------------
    ws = wb.create_sheet("CHAMADOS")
    cab = ["ID EVENTO", "EVENTO", "DATA", "DESCRIÇÃO", "TIPO", "INÍCIO", "FIM", "TEMPO (MIN)", "SLA"]
    _faixa(ws, len(cab), "Chamados de manutenção", "SLA: atendimento em até 60 minutos")
    linhas = []
    for c in ch:
        e = ev.get(c["evento_id"])
        if not e:
            continue
        t = calculos.minutos(c["hora_inicio"], c["hora_final"])
        linhas.append([e["id"], e["nome"], _d(e["data"]), c["descricao"], c["tipo"], c["hora_inicio"], c["hora_final"], t,
                       calculos.sla(t)])
    _tabela(ws, "tbChamados", cab, linhas, [INT, None, DATA, None, None, None, None, INT, None],
            [10, 30, 12, 60, 18, 9, 9, 12, 16])

    # ENERGIA --------------------------------------------------------------
    ws = wb.create_sheet("ENERGIA")
    cab = ["ID EVENTO", "EVENTO", "DATA", "ORDEM", "DATA CONSUMO", "HORA", "CONSUMO (KWH)"]
    _faixa(ws, len(cab), "Energia por hora", "Curva de consumo elétrico (kWh)")
    linhas = [[ev[r["evento_id"]]["id"], ev[r["evento_id"]]["nome"], _d(ev[r["evento_id"]]["data"]), r["ordem"],
               _d(r["data_consumo"]), r["hora"], r["consumo"]] for r in en if r["evento_id"] in ev]
    _tabela(ws, "tbEnergia", cab, linhas, [INT, None, DATA, INT, DATA, None, NUM], [10, 34, 12, 9, 14, 9, 15])

    # CATALOGO -------------------------------------------------------------
    ws = wb.create_sheet("CATALOGO")
    cab = ["TIPO", "ITEM", "VALOR UNIT. (R$)"]
    _faixa(ws, len(cab) + 2, "Catálogo de preços", "Valores unitários usados no cadastro de itens")
    linhas = [[c["tipo"], c["item"], c["valor_unit"]] for c in cat]
    _tabela(ws, "tbCatalogo", cab, linhas, [None, None, BRL], [14, 60, 18])

    for w in wb.worksheets:
        w.sheet_properties.tabColor = ROXO if w.title != "LEIA-ME" else VERDE_900

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def gerar_modelo():
    """Planilha de importação (exemplo) do Relatório de eventos: mesmas abas do Excel exportado,
    só com as colunas que a importação lê e linhas de exemplo."""
    wb = Workbook()
    ws = wb.active
    ws.title = "LEIA-ME"
    _faixa(ws, 8, "Planilha de importação (exemplo) · Relatório de eventos", "Central de Engenharia · Engenharia & Infraestrutura")
    ws.sheet_view.showGridLines = False
    texto = [
        ("Como preencher", True),
        ("Preencha a partir da linha 5 de cada aba (a linha 4 é o cabeçalho). Não mude os nomes das abas nem das colunas.", False),
        ("As linhas preenchidas são EXEMPLOS (evento “SHOW EXEMPLO”): apague antes de importar.", False),
        ("Importe em Relatório de eventos › Importar / Exportar › Importar planilha.", False),
        ("O evento é identificado pelo NOME + DATA. Com “Substituir” marcado, os itens/medidores/chamados desse evento são regravados (não duplica).", False),
        ("", False),
        ("Abas", True),
        ("EVENTOS · um evento por linha: nome, data, categoria (JOGO, SHOW...), gênero, horário, público e cliente.", False),
        ("ITENS · custos do evento: TIPO = AVARIAS, MDO ou INSUMOS; item, valor unitário e quantidade.", False),
        ("MEDIDORES · TIPO = ÁGUA, GÁS, ELÉTRICA, POÇO ou IRRIGAÇÃO; consumo (m³ ou kWh) e valor em R$.", False),
        ("CHAMADOS · descrição, tipo (área), hora de início e fim (o SLA é calculado).", False),
        ("ENERGIA · consumo de energia por hora (kWh). ORDEM = 1, 2, 3... na sequência das horas.", False),
        ("CATALOGO · tabela de preços (opcional).", False),
        ("Pode deixar abas vazias ou apagar as que não for usar, inclusive EVENTOS: o evento é achado pelo nome e pela data (se for o único evento do dia, basta a data).", False),
        ("Ao importar, o site troca só o que veio na planilha: mandar as AVARIAS de um evento não apaga a MDO nem os insumos dele.", False),
    ]
    for i, (t, negrito) in enumerate(texto, 5):
        ws.cell(i, 1, t).font = Font(name=FONTE, size=12 if negrito else 10, bold=negrito, color=ROXO if negrito else "1E002F")
    ws.column_dimensions["A"].width = 130
    d = dt.date.today()
    ev, dia = "SHOW EXEMPLO", d
    abas = [
        ("EVENTOS", "Eventos", "Um evento por linha", "tbEventos",
         ["EVENTO", "DATA", "CATEGORIA", "GÊNERO", "HORÁRIO", "PÚBLICO", "CLIENTE"],
         [[ev, dia, "SHOW", "POP", "21:00", 42000, "PRODUTORA EXEMPLO"]],
         [None, DATA, None, None, None, INT, None], [34, 12, 16, 16, 10, 10, 24]),
        ("ITENS", "Itens de custo", "Avarias, mão de obra (MDO) e insumos", "tbItens",
         ["EVENTO", "DATA", "TIPO", "ITEM", "VALOR UNIT. (R$)", "QTD."],
         [[ev, dia, "AVARIAS", "CADEIRA QUEBRADA", 350, 4], [ev, dia, "MDO", "ELETRICISTA (DIÁRIA)", 480, 3],
          [ev, dia, "INSUMOS", "LÂMPADA LED 20W", 18.9, 25]],
         [None, DATA, None, None, BRL, NUM], [34, 12, 12, 50, 16, 9]),
        ("MEDIDORES", "Medidores de consumo", "Água e poço em m³ · gás em m³ · energia em kWh", "tbMedidores",
         ["EVENTO", "DATA", "TIPO", "CONSUMO", "VALOR (R$)"],
         [[ev, dia, "ÁGUA", 820, 14350], [ev, dia, "GÁS", 95, 760], [ev, dia, "ELÉTRICA", 18500, 15725], [ev, dia, "POÇO", 210, 0]],
         [None, DATA, None, NUM, BRL], [34, 12, 12, 14, 16]),
        ("CHAMADOS", "Chamados de manutenção", "SLA: atendimento em até 60 minutos", "tbChamados",
         ["EVENTO", "DATA", "DESCRIÇÃO", "TIPO", "INÍCIO", "FIM"],
         [[ev, dia, "VAZAMENTO NO SANITÁRIO DO SETOR NORTE", "HIDRÁULICA", "19:40", "20:05"],
          [ev, dia, "TOMADA SEM ENERGIA NO BAR 3", "ELÉTRICA", "20:10", "21:30"]],
         [None, DATA, None, None, None, None], [34, 12, 56, 18, 9, 9]),
        ("ENERGIA", "Energia por hora", "Curva de consumo elétrico (kWh)", "tbEnergia",
         ["EVENTO", "DATA", "ORDEM", "DATA CONSUMO", "HORA", "CONSUMO (KWH)"],
         [[ev, dia, 1, dia, "18:00", 1450], [ev, dia, 2, dia, "19:00", 2100], [ev, dia, 3, dia, "20:00", 2650]],
         [None, DATA, INT, DATA, None, NUM], [34, 12, 9, 14, 9, 15]),
        ("CATALOGO", "Catálogo de preços", "Valores unitários usados no cadastro de itens", "tbCatalogo",
         ["TIPO", "ITEM", "VALOR UNIT. (R$)"],
         [["AVARIAS", "CADEIRA QUEBRADA", 350], ["MDO", "ELETRICISTA (DIÁRIA)", 480]],
         [None, None, BRL], [14, 50, 18]),
    ]
    for nome, tit, sub, tb, cab, linhas, fmts, larg in abas:
        w = wb.create_sheet(nome)
        _faixa(w, max(len(cab), 4), tit, sub)
        _tabela(w, tb, cab, linhas, fmts, larg)
        w.sheet_properties.tabColor = ROXO
    ws.sheet_properties.tabColor = VERDE_900
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf
