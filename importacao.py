"""Planilha ÚNICA de importação (Notas fiscais + Budget/Pedidos + Documentos).

- Gerada pelo site já com a guia LISTAS preenchida (centros de custo, projetos, classes, contratos e
  pedidos que estão no site). As colunas de Nº nas outras guias têm lista suspensa vinda da LISTAS e a
  descrição ao lado é puxada sozinha (PROCV). O centro de custo já vem do projeto e o fornecedor já vem
  do contrato ou do pedido; dá para trocar.
- Na importação: primeiro a LISTAS (o que for novo vira cadastro), depois o budget (pedidos, budget,
  realocações) e por último as notas fiscais (contratos, itens, medições, prazos, feriados).
"""
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

import budget
import docs
import exporter
import importer

LINHAS = 500          # linhas já preparadas (fórmulas e listas) em cada guia
MAX_LISTA = 3000      # tamanho máximo das listas
AVISO = "NÃO ESTÁ NAS LISTAS"

# guia LISTAS: (coluna inicial, título do bloco, cabeçalhos, nome da lista suspensa da 1ª coluna)
BLOCOS = [
    ("A", "Centros de custo", ["CENTRO DE CUSTO (Nº)", "CENTRO DE CUSTO (DESCRIÇÃO)"], "L_CC"),
    ("D", "Projetos", ["PROJETO (Nº)", "PROJETO (DESCRIÇÃO)", "PROJETO - CENTRO DE CUSTO (Nº)"], "L_PROJETO"),
    ("H", "Classes financeiras", ["CLASSE FINANCEIRA (Nº)", "CLASSE FINANCEIRA (DESCRIÇÃO)"], "L_CLASSE"),
    ("K", "Contratos", ["CONTRATO (Nº)", "CONTRATO - FORNECEDOR", "CONTRATO - CLASSE DAS MEDIÇÕES"], "L_CONTRATO"),
    ("O", "Pedidos de compra", ["PEDIDO (Nº)", "PEDIDO - FORNECEDOR"], "L_PEDIDO"),
    ("R", "Motivos do pedido", ["MOTIVO DO PEDIDO"], "L_MOTIVO"),
    ("T", "Status da NF", ["STATUS DA NF"], "L_STATUS_NF"),
    ("V", "Status do pedido", ["STATUS DO PEDIDO"], "L_STATUS_PEDIDO"),
    ("X", "Sim / não", ["SIM / NÃO"], "L_SIMNAO"),
    ("Z", "Categorias de documento", ["CATEGORIA DO DOCUMENTO"], "L_CAT_DOC"),
]


def ws_col(letra):
    from openpyxl.utils import column_index_from_string
    return column_index_from_string(letra)


def _procv(cel, col_ini, ncols, idx):
    """Descrição puxada da LISTAS; vazio se a célula está vazia; aviso se o Nº não está na lista."""
    fim = get_column_letter(ws_col(col_ini) + ncols - 1)
    return (f'=IF({cel}="","",IFERROR(VLOOKUP({cel},LISTAS!${col_ini}$5:${fim}${MAX_LISTA},{idx},FALSE),"{AVISO}"))')


def _procv_vazio(cel, col_ini, ncols, idx):
    """Igual, mas sem aviso (para sugestões: centro de custo do projeto, fornecedor do pedido)."""
    fim = get_column_letter(ws_col(col_ini) + ncols - 1)
    return f'=IF({cel}="","",IFERROR(VLOOKUP({cel},LISTAS!${col_ini}$5:${fim}${MAX_LISTA},{idx},FALSE),""))'


# guias de dados: nome -> lista de colunas (cabeçalho, largura, formato, lista suspensa, fórmula(linha) ou None)
def _guias():
    T, D, B = "@", exporter.DATA, exporter.BRL
    pj = lambda c: _procv(c, "D", 3, 2)
    cc_do_pj = lambda c: _procv_vazio(c, "D", 3, 3)
    cc = lambda c: _procv(c, "A", 2, 2)
    cl = lambda c: _procv(c, "H", 2, 2)
    forn_ct = lambda c: _procv_vazio(c, "K", 3, 2)
    forn_ped = lambda c: _procv_vazio(c, "O", 2, 2)
    return {
        "PEDIDOS": ("Pedidos de compra", "Notas fiscais › Pedidos de compra · o fornecedor vem da LISTAS quando o pedido já está lá (ex.: lido do PDF)", [
            ("Nº PEDIDO", 13, T, "L_PEDIDO", None),
            ("FORNECEDOR", 34, None, None, lambda r: forn_ped(f"A{r}")),
            ("DATA EMISSÃO", 13, D, None, None),
            ("VALOR TOTAL (R$)", 15, B, None, None),
            ("MOTIVO", 26, None, "L_MOTIVO", None),
            ("PROJETO (Nº)", 12, T, "L_PROJETO", None),
            ("PROJETO (DESCRIÇÃO)", 28, None, None, lambda r: pj(f"F{r}")),
            ("CENTRO DE CUSTO (Nº)", 13, T, "L_CC", lambda r: cc_do_pj(f"F{r}")),
            ("CENTRO DE CUSTO (DESCRIÇÃO)", 26, None, None, lambda r: cc(f"H{r}")),
            ("CLASSE FINANCEIRA (Nº)", 13, T, "L_CLASSE", None),
            ("CLASSE FINANCEIRA (DESCRIÇÃO)", 30, None, None, lambda r: cl(f"J{r}")),
            ("OBSERVAÇÃO", 30, None, None, None),
            ("STATUS", 12, None, "L_STATUS_PEDIDO", None),
            ("CAMINHO DO ANEXO", 40, None, None, None),
            ("DESCRIÇÃO DO PEDIDO (ITENS)", 36, None, None, None)]),
        "MEDIÇÕES (DADOS)": ("Medições / notas fiscais", "Notas fiscais › Medições · use CONTRATO ou PEDIDO (NF de material/serviço avulso)", [
            ("MEDIÇÃO", 11, T, None, None),
            ("NF", 12, T, None, None),
            ("CONTRATO", 11, T, "L_CONTRATO", None),
            ("PEDIDO", 11, T, "L_PEDIDO", None),
            ("FORNECEDOR", 34, None, None, lambda r: f'=IF(C{r}<>"",IFERROR(VLOOKUP(C{r},LISTAS!$K$5:$M${MAX_LISTA},2,FALSE),"{AVISO}"),'
                                                     f'IF(D{r}<>"",IFERROR(VLOOKUP(D{r},LISTAS!$O$5:$P${MAX_LISTA},2,FALSE),"{AVISO}"),""))'),
            ("ITEM", 7, T, None, None),
            ("CLASSE FINANCEIRA PELO CONTRATO", 34, None, None, lambda r: (
                f'=IF(I{r}<>"","(usa a classe digitada ao lado)",IF(C{r}="",IF(D{r}<>"","(usa a classe do pedido)",""),'
                f'IF(F{r}<>"","(usa a linha "&F{r}&" do contrato)",IFERROR(VLOOKUP(C{r},LISTAS!$K$5:$M${MAX_LISTA},3,FALSE),"{AVISO}"))))')),
            ("PROJETO (Nº)", 12, T, "L_PROJETO", None),
            ("CLASSE FINANCEIRA (Nº)", 13, T, "L_CLASSE", None),
            ("DATA EMISSÃO", 13, D, None, None),
            ("DATA VENCIMENTO", 14, D, None, None),
            ("DATA MEDIÇÃO", 13, D, None, None),
            ("VALOR", 14, B, None, None),
            ("STATUS", 12, None, "L_STATUS_NF", None),
            ("OBS", 28, None, None, None),
            ("CAMINHO NF", 40, None, None, None)]),
        "CONTRATOS": ("Contratos", "Notas fiscais › Contratos · o fornecedor vem da LISTAS quando o contrato já está lá", [
            ("CONTRATO", 11, T, "L_CONTRATO", None),
            ("FORNECEDOR", 36, None, None, lambda r: forn_ct(f"A{r}")),
            ("DATA INÍCIO", 13, D, None, None),
            ("DATA FINAL", 13, D, None, None),
            ("SALDO CONTRATADO", 17, B, None, None),
            ("ADITIVO", 14, B, None, None),
            ("FINALIZADO", 11, None, "L_SIMNAO", None)]),
        "ITENS CONTRATO": ("Itens (linhas) dos contratos", "Cada item pode ter projeto, centro de custo e classe financeira próprios", [
            ("CONTRATO", 11, T, "L_CONTRATO", None),
            ("FORNECEDOR DO CONTRATO", 32, None, None, lambda r: _procv(f"A{r}", "K", 3, 2)),
            ("ITEM", 7, T, None, None),
            ("DESCRIÇÃO", 28, None, None, None),
            ("PROJETO (Nº)", 12, T, "L_PROJETO", None),
            ("PROJETO (DESCRIÇÃO)", 28, None, None, lambda r: pj(f"E{r}")),
            ("CENTRO DE CUSTO (Nº)", 13, T, "L_CC", lambda r: cc_do_pj(f"E{r}")),
            ("CENTRO DE CUSTO (DESCRIÇÃO)", 26, None, None, lambda r: cc(f"G{r}")),
            ("CLASSE FINANCEIRA (Nº)", 13, T, "L_CLASSE", None),
            ("CLASSE FINANCEIRA (DESCRIÇÃO)", 30, None, None, lambda r: cl(f"I{r}"))]),
        "BUDGET": ("Budget por ano", "Cada classe de cada projeto/centro de custo tem seus valores · já vem com as linhas conhecidas: digite SOLICITADO e APROVADO", [
            ("ANO", 7, exporter.INT, None, None),
            ("PROJETO (Nº)", 12, T, "L_PROJETO", None),
            ("PROJETO (DESCRIÇÃO)", 28, None, None, lambda r: pj(f"B{r}")),
            ("CENTRO DE CUSTO (Nº)", 13, T, "L_CC", lambda r: cc_do_pj(f"B{r}")),
            ("CENTRO DE CUSTO (DESCRIÇÃO)", 26, None, None, lambda r: cc(f"D{r}")),
            ("CLASSE FINANCEIRA (Nº)", 13, T, "L_CLASSE", None),
            ("CLASSE FINANCEIRA (DESCRIÇÃO)", 30, None, None, lambda r: cl(f"F{r}")),
            ("SOLICITADO (R$)", 16, B, None, None),
            ("APROVADO (R$)", 16, B, None, None),
            ("DIFERENÇA (APROVADO − SOLICITADO)", 18, B, None, lambda r: f'=IF(OR(H{r}="",I{r}=""),"",I{r}-H{r})')]),
        "DOCUMENTOS": ("Documentos e vencimentos", "Documentos › mesmo nome + categoria = atualiza as datas; os arquivos (PDF) são anexados no site", [
            ("NOME DO DOCUMENTO", 34, None, None, None),
            ("CATEGORIA", 24, None, "L_CAT_DOC", None),
            ("Nº / PROTOCOLO", 16, T, None, None),
            ("ÓRGÃO / ÁREA", 22, None, None, None),
            ("RESPONSÁVEL", 20, None, None, None),
            ("DATA DE RENOVAÇÃO", 14, D, None, None),
            ("DATA DE VENCIMENTO", 14, D, None, None),
            ("AVISAR (DIAS ANTES)", 12, exporter.INT, None, None),
            ("OBSERVAÇÃO", 34, None, None, None)]),
        "PRAZO RECEBIMENTO NFS": ("Prazo de recebimento das NFs", "Data limite para os fornecedores mandarem as NFs de cada mês", [
            ("MÊS", 11, "mm/yyyy", None, None),
            ("PRAZO", 13, D, None, None),
            ("STATUS", 14, None, None, None)]),
        "FERIADOS": ("Feriados", "Não contam como dia útil", [
            ("DATA", 13, D, None, None),
            ("DESCRIÇÃO", 30, None, None, None)]),
    }


GUIAS_BUDGET = ("PEDIDOS", "BUDGET", "REALOCACOES")
GUIAS_DOCS = ("DOCUMENTOS",)
GUIAS_NF = ("CONTRATOS", "ITENS CONTRATO", "DADOS", "PRAZO", "FERIADOS", "CADASTRO")


def gerar_modelo(con, acessos):
    wb = Workbook()
    ws = wb.active
    ws.title = "LEIA-ME"
    exporter._faixa(ws, 8, "Planilha de importação · Central de Engenharia", "Notas fiscais, contratos, pedidos e budget — tudo numa planilha só")
    ws.sheet_view.showGridLines = False
    textos = [
        ("Como usar", True),
        ("1. Na guia LISTAS ficam os itens das listas suspensas (já vêm com o que está no site). Pode acrescentar novos no fim de cada bloco.", False),
        ("2. Nas outras guias, escolha o Nº na lista suspensa: a DESCRIÇÃO ao lado aparece sozinha.", False),
        ("3. O que dá para deduzir já vem preenchido: o centro de custo vem do projeto; o fornecedor vem do contrato ou do pedido. Pode trocar.", False),
        ("4. Preencha a partir da linha 5 (a linha 4 é o cabeçalho). Não mude os nomes das guias nem das colunas. Guias que não usar podem ficar vazias.", False),
        ("5. Importe pelo botão “Importar planilha” (Budget, Pedidos, Cadastros, Medições, Contratos ou Documentos): o site lê todas as guias.", False),
        ("", False),
        ("O que acontece na importação", True),
        ("LISTAS: centros de custo, projetos, classes, contratos e pedidos novos são cadastrados (os que já existem só completam o que está vazio).", False),
        ("PEDIDOS: pedido que já existe (ex.: lido do PDF) só tem os campos vazios completados. Projeto e centro de custo lidos do PDF são usados se a linha não tiver.", False),
        ("MEDIÇÕES: use CONTRATO ou PEDIDO. NF de pedido não precisa de contrato (o fornecedor vem do pedido) e não soma de novo no budget.", False),
        ("        A coluna “CLASSE FINANCEIRA PELO CONTRATO” mostra a classe que a medição vai receber sozinha (contrato com uma linha só).", False),
        ("        Quando aparecer em laranja (“VÁRIAS LINHAS” ou “SEM LINHA”), informe o ITEM do contrato ou o PROJETO + CLASSE FINANCEIRA da medição.", False),
        ("CONTRATOS / ITENS CONTRATO / PRAZO / FERIADOS: só entra o que falta.", False),
        ("DOCUMENTOS: já vem com os documentos do site. Mesmo nome + categoria = atualiza (só as células preenchidas); nome novo = documento novo.", False),
        ("BUDGET: já vem com as linhas do ano (as do budget, as com incorrido e as dos itens de contrato). Para cada uma digite o SOLICITADO (pedido pela", False),
        ("        gestora) e o APROVADO (aprovado pela controladoria). A mesma classe pode ter valores diferentes em projetos/centros de custo diferentes.", False),
        ("        Célula em branco = aquele valor não é mexido no site. O saldo e o % executado são calculados sobre o APROVADO (linha sem aprovado fica sem saldo).", False),
        ("Células com “NÃO ESTÁ NAS LISTAS”: o Nº digitado não está na guia LISTAS (confira ou acrescente na LISTAS).", False),
    ]
    for i, (t, b) in enumerate(textos, 5):
        ws.cell(i, 1, t).font = Font(name=exporter.FONTE, size=12 if b else 10, bold=b, color=exporter.ROXO if b else "1E002F")
    ws.column_dimensions["A"].width = 150
    ws.sheet_properties.tabColor = exporter.VERDE_900

    # ---- LISTAS
    wl = wb.create_sheet("LISTAS")
    exporter._faixa(wl, 23, "Listas", "Itens das listas suspensas — acrescente novos no fim de cada bloco (o site cadastra ao importar)")
    wl.sheet_view.showGridLines = False
    cad = budget.cadastros(con)
    dados = {
        "L_CC": [[c["nome"], c["descricao"] or ""] for c in cad["centros"]],
        "L_PROJETO": [[p["nome"], p["descricao"] or "", p["centro_custo"] or ""] for p in cad["projetos"]],
        "L_CLASSE": [[c["numero"], c["descricao"] or ""] for c in cad["classes"]],
        "L_CONTRATO": _contratos_lista(con),
        "L_PEDIDO": [[r["numero"], r["fornecedor"] or ""] for r in con.execute("SELECT numero, fornecedor FROM bud_pedidos ORDER BY data_emissao DESC, id DESC")],
        "L_MOTIVO": [[m] for m in budget.MOTIVOS],
        "L_STATUS_NF": [["ENVIADO"], ["PENDENTE"], ["CANCELADA"]],
        "L_STATUS_PEDIDO": [["ATIVO"], ["CANCELADO"]],
        "L_SIMNAO": [["SIM"], ["NÃO"]],
        "L_CAT_DOC": [[c] for c in sorted({r[0] for r in con.execute("SELECT categoria FROM doc_documentos WHERE categoria<>''")}
                                          | set(docs.CATEGORIAS_PADRAO))] if _tem_tabela(con, "doc_documentos") else [[c] for c in docs.CATEGORIAS_PADRAO],
    }
    cab_fill = PatternFill("solid", fgColor=exporter.ROXO)
    for col, titulo, cabs, nome in BLOCOS:
        c0 = ws_col(col)
        wl.cell(3, c0, titulo).font = Font(name=exporter.FONTE, bold=True, color=exporter.ROXO_900, size=10)
        for j, h in enumerate(cabs):
            c = wl.cell(4, c0 + j, h)
            c.font = Font(name=exporter.FONTE, bold=True, color="FFFFFF", size=10)
            c.fill = cab_fill
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            wl.column_dimensions[get_column_letter(c0 + j)].width = 14 if j == 0 else (36 if "DESCRI" in h or "FORNECEDOR" in h else 16)
        for i, linha in enumerate(dados[nome], 5):
            for j, v in enumerate(linha):
                cel = wl.cell(i, c0 + j, v)
                cel.font = Font(name=exporter.FONTE, size=10)
        for i in range(5, MAX_LISTA + 1):          # Nº como texto (9010 digitado não vira número)
            wl.cell(i, c0).number_format = "@"
            if nome == "L_PROJETO":
                wl.cell(i, c0 + 2).number_format = "@"
        wl.column_dimensions[get_column_letter(c0 + len(cabs))].width = 3
        ref = f"OFFSET(LISTAS!${col}$5,0,0,MAX(1,COUNTA(LISTAS!${col}$5:${col}${MAX_LISTA})),1)"
        wb.defined_names[nome] = DefinedName(nome, attr_text=ref)
    wl.row_dimensions[4].height = 30
    wl.freeze_panes = "A5"
    wl.sheet_properties.tabColor = exporter.VERDE_900

    # ---- guias de dados
    mostrar = [g for g in _guias() if not (("budget" not in acessos and g in ("PEDIDOS", "BUDGET"))
                                          or ("nf" not in acessos and g in ("MEDIÇÕES (DADOS)", "CONTRATOS", "ITENS CONTRATO", "PRAZO RECEBIMENTO NFS", "FERIADOS"))
                                          or ("docs" not in acessos and g == "DOCUMENTOS"))]
    guias = _guias()
    for nome in mostrar:
        titulo, sub, cols = guias[nome]
        wsd = wb.create_sheet(nome)
        exporter._faixa(wsd, max(len(cols), 4), titulo, sub)
        wsd.sheet_view.showGridLines = False
        for j, (h, larg, fmt, lista, formula) in enumerate(cols, 1):
            c = wsd.cell(4, j, h)
            c.font = Font(name=exporter.FONTE, bold=True, color="FFFFFF", size=10)
            c.fill = PatternFill("solid", fgColor=exporter.ROXO if not formula or lista else exporter.ROXO_900)
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            wsd.column_dimensions[get_column_letter(j)].width = larg
            letra = get_column_letter(j)
            for r in range(5, 5 + LINHAS):
                cel = wsd.cell(r, j)
                if formula:
                    cel.value = formula(r)
                    if not lista:   # coluna só de consulta (descrição puxada): cinza
                        cel.font = Font(name=exporter.FONTE, size=10, color="6B6378", italic=True)
                if fmt:
                    cel.number_format = fmt
            if lista:
                dv = DataValidation(type="list", formula1=f"={lista}", allow_blank=True, showErrorMessage=True, errorStyle="warning",
                                    errorTitle="Não está na lista", error="Esse Nº não está na guia LISTAS. Se for novo, pode continuar: o site cadastra ao importar.")
                wsd.add_data_validation(dv)
                dv.add(f"{letra}5:{letra}{4 + LINHAS}")
        if nome == "MEDIÇÕES (DADOS)":   # destaca as medições que precisam da classe à mão
            from openpyxl.formatting.rule import FormulaRule
            col = get_column_letter([c[0] for c in cols].index("CLASSE FINANCEIRA PELO CONTRATO") + 1)
            faixa = f"{col}5:{col}{4 + LINHAS}"
            wsd.conditional_formatting.add(faixa, FormulaRule(
                formula=[f'OR(LEFT({col}5,6)="VÁRIAS",LEFT({col}5,10)="SEM LINHA ",{col}5="{AVISO}")'],
                fill=PatternFill("solid", fgColor="FDE9C9"), font=Font(color="9A4A00", bold=True)))
        wsd.row_dimensions[4].height = 32
        wsd.freeze_panes = "B5"
        wsd.auto_filter.ref = f"A4:{get_column_letter(len(cols))}{4 + LINHAS}"
        wsd.sheet_properties.tabColor = exporter.ROXO
        if nome == "BUDGET":   # já vem com as linhas conhecidas do ano: só falta digitar o previsto
            import datetime as _dt
            ano = _dt.date.today().year
            for k, l in enumerate(budget.linhas_para_previsto(con, ano)[:LINHAS], 5):
                wsd.cell(k, 1, ano)
                wsd.cell(k, 2, l["projeto"])
                wsd.cell(k, 4, l["centro_custo"])
                wsd.cell(k, 6, l["classe_numero"])
                if l["solicitado"] is not None:
                    wsd.cell(k, 8, l["solicitado"])
                if l["aprovado"] is not None:
                    wsd.cell(k, 9, l["aprovado"])
        if nome == "DOCUMENTOS" and _tem_tabela(con, "doc_documentos"):   # já vem com os documentos do site: é só atualizar as datas
            for k, r in enumerate(con.execute("SELECT * FROM doc_documentos WHERE arquivado=0 ORDER BY categoria, nome").fetchall()[:LINHAS], 5):
                for j, v in enumerate([r["nome"], r["categoria"], r["numero"], r["orgao"], r["responsavel"],
                                       _data(r["data_renovacao"]), _data(r["data_vencimento"]),
                                       r["aviso_dias"], r["observacao"]], 1):
                    if v not in (None, ""):
                        wsd.cell(k, j, v)
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _contratos_lista(con):
    """Contratos para a guia LISTAS, com a classe que as medições de cada um recebem automaticamente:
    uma linha (ou todas as linhas com a mesma classe) -> essa classe; várias classes ou nenhuma -> aviso para informar à mão."""
    out = []
    for c in con.execute("""SELECT c.id, c.numero, c.fornecedor, bi.classe_numero, bi.classe_descricao
                            FROM nf_contratos c LEFT JOIN bud_itens bi ON bi.id = c.budget_item_id ORDER BY c.finalizado, c.numero"""):
        linhas = con.execute("""SELECT i.budget_item_id, bi.classe_numero, bi.classe_descricao, bi.projeto FROM nf_contrato_itens i
                                LEFT JOIN bud_itens bi ON bi.id = i.budget_item_id WHERE i.contrato_id=?""", (c["id"],)).fetchall()
        bids = {l["budget_item_id"] for l in linhas}
        if linhas and len(bids) == 1 and None not in bids:
            l = linhas[0]
            cls = f"{l['classe_numero']} {l['classe_descricao'] or ''} (projeto {l['projeto'] or '—'})".strip()
        elif not linhas and c["classe_numero"]:
            cls = f"{c['classe_numero']} {c['classe_descricao'] or ''}".strip()
        elif len(linhas) > 1:
            cls = f"VÁRIAS LINHAS ({len(linhas)}): INFORME O ITEM OU A CLASSE"
        else:
            cls = "SEM LINHA COM CLASSE: INFORME A CLASSE"
        out.append([c["numero"], c["fornecedor"], cls])
    return out


def _data(t):
    import datetime as _dt
    try:
        return _dt.date.fromisoformat((t or "")[:10])
    except ValueError:
        return t or None


def _tem_tabela(con, nome):
    return bool(con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (nome,)).fetchone())


# ----------------------------------------------------------------------------- importação
def _desc(v):
    t = importer.txt(v)
    return "" if t.startswith(importer.AVISOS_LISTA) else t


def nomes_guias(caminho):
    from python_calamine import CalamineWorkbook
    return [importer.sem_acento(n).upper().strip() for n in CalamineWorkbook.from_path(str(caminho)).sheet_names]


def importar_listas(con, caminho):
    """Guia LISTAS: cadastra o que for novo (e completa o que está vazio)."""
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(caminho))
    nome = next((n for n in wb.sheet_names if importer.sem_acento(n).upper().strip() == "LISTAS"), None)
    res = {"cadastros": 0, "contratos": 0, "pedidos": 0}
    if not nome:
        return None
    d = wb.get_sheet_by_name(nome).to_python()
    cab_i = next((i for i, r in enumerate(d[:10]) if any(importer.sem_acento(importer.up(x)) == "CENTRO DE CUSTO (Nº)" for x in r)), None)
    if cab_i is None:
        return res
    cab = [importer.sem_acento(importer.up(x)) for x in d[cab_i]]
    pos = {h: k for k, h in enumerate(cab) if h}

    def col(linha, h):
        k = pos.get(importer.sem_acento(h))
        return linha[k] if k is not None and k < len(linha) else None

    n_antes = lambda: sum(con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("bud_centros", "bud_projetos", "bud_classes"))
    antes = n_antes()
    for linha in d[cab_i + 1:]:
        cc = budget._cod(col(linha, "CENTRO DE CUSTO (Nº)"))
        if cc:
            budget._cadastrar(con, cc, "", "", "", importer.up(_desc(col(linha, "CENTRO DE CUSTO (DESCRIÇÃO)"))))
        pj = budget._cod(col(linha, "PROJETO (Nº)"))
        if pj:
            pcc = budget._cod(col(linha, "PROJETO - CENTRO DE CUSTO (Nº)"))
            budget._cadastrar(con, "", pj, "", "", "", importer.up(_desc(col(linha, "PROJETO (DESCRIÇÃO)"))))
            if pcc:
                con.execute("INSERT OR IGNORE INTO bud_centros(nome) VALUES (?)", (pcc,))
                con.execute("UPDATE bud_projetos SET centro_custo=? WHERE nome=? AND COALESCE(centro_custo,'')=''", (pcc, pj))
        cl = budget._txt(col(linha, "CLASSE FINANCEIRA (Nº)"))
        if cl:
            budget._cadastrar(con, "", "", cl, importer.up(_desc(col(linha, "CLASSE FINANCEIRA (DESCRIÇÃO)"))))
        ct = budget._txt(col(linha, "CONTRATO (Nº)"))
        if ct:
            forn = importer.up(_desc(col(linha, "CONTRATO - FORNECEDOR")))
            atual = con.execute("SELECT id, fornecedor FROM nf_contratos WHERE numero=?", (ct,)).fetchone()
            if not atual:
                con.execute("INSERT INTO nf_contratos(numero, fornecedor) VALUES (?,?)", (ct, forn or "SEM FORNECEDOR"))
                res["contratos"] += 1
            elif forn and atual["fornecedor"] in ("", "SEM FORNECEDOR"):
                con.execute("UPDATE nf_contratos SET fornecedor=? WHERE id=?", (forn, atual["id"]))
        pd = budget._txt(col(linha, "PEDIDO (Nº)"))
        if pd:
            forn = importer.up(_desc(col(linha, "PEDIDO - FORNECEDOR")))
            atual = con.execute("SELECT id, fornecedor FROM bud_pedidos WHERE numero=?", (pd,)).fetchone()
            if not atual:
                con.execute("INSERT INTO bud_pedidos(numero, fornecedor) VALUES (?,?)", (pd, forn))
                res["pedidos"] += 1
            elif forn and not atual["fornecedor"]:
                con.execute("UPDATE bud_pedidos SET fornecedor=? WHERE id=?", (forn, atual["id"]))
    res["cadastros"] = n_antes() - antes
    return res
