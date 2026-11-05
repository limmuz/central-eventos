"""Suprimentos: rateio mensal das contas de consumo (energia elétrica, água e gás).

Cada mês tem as CONTAS das concessionárias (Enel, Esfera, Sabesp, Comgás...) e as LINHAS de rateio:
quanto de cada conta vai para cada centro de custo + projeto (locações, catering, eventos...).
Cada linha pode ter um DESCONTO em % (escolhendo em quais contas ele vale); a parte descontada volta
para a Engenharia. A ENGENHARIA não é digitada: é o total das contas menos o que foi repassado.

Exporta a planilha do requisitante, a planilha de importação do Suprimentos (uma por conta) e a base
para importar de volta no site.
"""
import datetime as dt
import re
from io import BytesIO

from flask import abort, jsonify, request, send_file

import db
import importer
import visao

UTIL = [("energia", "Energia elétrica"), ("agua", "Água"), ("gas", "Gás")]
UKEYS = [u for u, _ in UTIL]
CONFIG_PADRAO = {
    "cc_engenharia": "100", "projeto_engenharia": "9000",
    "agente_energia": "7001", "agente_agua": "7002", "agente_gas": "7003",   # concessionárias (códigos de exemplo)
    "organizacao": "1", "filial": "1", "acao": "100",
    "gatex_link": "",            # link do GateX copiado do navegador (com o sid da sessão)
    # centro de custo de cada categoria de evento (linhas trazidas do Relatório de eventos e filtros do resumo)
    "cc_show": "101", "cc_jogo": "102", "cc_projeto_especial": "103",
    # a medição de um mês usa a tarifa da conta do mês anterior (como na planilha de consumos dos locatários)
    "tarifa_mes_anterior": "1",
    # poço artesiano nos meses novos: "1" = coluna própria no rateio; "0" = somado à água (como Enel + Esfera na energia)
    "poco_separado": "1",
}
QCOL = {"energia": "energia_kwh", "agua": "agua_m3", "gas": "gas_m3"}          # consumo medido da linha
UNIDADE = {"energia": "kWh", "agua": "m³", "gas": "m³"}
CATEGORIA_CC = {"SHOW": "cc_show", "JOGO": "cc_jogo", "PROJETO ESPECIAL": "cc_projeto_especial"}
NOMES_AGENTE = {"7001": "Energia (exemplo)", "7002": "Água (exemplo)", "7003": "Gás (exemplo)"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS sup_config (chave TEXT PRIMARY KEY, valor TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sup_meses (
    mes         TEXT PRIMARY KEY,               -- AAAA-MM (competência)
    observacao  TEXT DEFAULT '',
    criado_em   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sup_contas (             -- contas das concessionárias
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    mes              TEXT NOT NULL,
    utilidade        TEXT NOT NULL,             -- energia | agua | gas
    fornecedor       TEXT DEFAULT '',
    numero_doc       TEXT DEFAULT '',
    data_emissao     TEXT DEFAULT '',
    data_vencimento  TEXT DEFAULT '',
    valor            REAL DEFAULT 0,
    observacao       TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sup_linhas (             -- rateio: quanto de cada conta vai para cada CC + projeto
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mes           TEXT NOT NULL,
    ordem         INTEGER DEFAULT 0,
    centro_custo  TEXT DEFAULT '',              -- nº (código) do centro de custo
    projeto       TEXT DEFAULT '',              -- nº (código) do projeto
    descricao     TEXT DEFAULT '',              -- nome da linha (ex.: Loja Exemplo, TIME A x TIME B - 04/09/26)
    energia       REAL DEFAULT 0,
    agua          REAL DEFAULT 0,
    gas           REAL DEFAULT 0,
    desc_pct      REAL DEFAULT 0,               -- desconto em % (a parte descontada volta para a Engenharia)
    desc_energia  INTEGER DEFAULT 0,
    desc_agua     INTEGER DEFAULT 0,
    desc_gas      INTEGER DEFAULT 0,
    observacao    TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sup_gatex_mapa (        -- item do GateX -> linha do rateio (lembrado de um mês para o outro)
    chave      TEXT PRIMARY KEY,                -- T:<id do locatário> | E:<nome do evento>
    descricao  TEXT DEFAULT '',                 -- nome da linha do rateio
    ignorar    INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sup_tarifas (            -- base da tarifa: conta do mês (R$) ÷ consumo do mês
    mes        TEXT NOT NULL,
    utilidade  TEXT NOT NULL,
    fatura     REAL,                            -- valor total da(s) conta(s) do mês
    consumo    REAL,                            -- kWh (energia) ou m³ (água, gás)
    tarifa     REAL,                            -- digitada (se vazio, é fatura ÷ consumo)
    PRIMARY KEY (mes, utilidade)
);
CREATE TABLE IF NOT EXISTS sup_conta_rateio (       -- parte da Engenharia de cada conta -> linhas do budget (CC + projeto + classe)
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_id  INTEGER NOT NULL,
    item_id   INTEGER NOT NULL,                     -- bud_itens.id
    pct       REAL NOT NULL                         -- % da parte da Engenharia desta conta
);
CREATE INDEX IF NOT EXISTS ix_sup_conta_rateio ON sup_conta_rateio(conta_id);
CREATE INDEX IF NOT EXISTS ix_sup_contas_mes ON sup_contas(mes);
CREATE INDEX IF NOT EXISTS ix_sup_linhas_mes ON sup_linhas(mes);
"""


# ----------------------------------------------------------------------------- utilidades
def config(con):
    c = dict(CONFIG_PADRAO)
    c.update({r["chave"]: r["valor"] for r in con.execute("SELECT chave, valor FROM sup_config")})
    return c


def _mes_ok(m):
    m = (m or "").strip()[:7]
    if not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", m):
        abort(400, "Mês inválido (use AAAA-MM).")
    return m


def _norm(s):
    return re.sub(r"\s+", " ", importer.sem_acento(str(s or "")).lower()).strip()


def eh_conta_poco(c):
    """Conta do poço artesiano (lançada como água com fornecedor 'Poço ...')."""
    return "poco" in _norm(c.get("fornecedor")) or "artesiano" in _norm(c.get("fornecedor"))


def utilidade_de(txt):
    t = _norm(txt)
    if "poco" in t or "artesiano" in t:
        return "agua"
    if any(k in t for k in ("energ", "enel", "esfera", "eletropaulo", "luz")):
        return "energia"
    if any(k in t for k in ("agua", "sabesp", "saneamento")):
        return "agua"
    if any(k in t for k in ("gas", "comgas")):
        return "gas"
    return None


def descricoes(con):
    cc = {r["nome"]: r["descricao"] or "" for r in con.execute("SELECT nome, descricao FROM bud_centros")}
    pj = {r["nome"]: r["descricao"] or "" for r in con.execute("SELECT nome, descricao FROM bud_projetos")}
    return cc, pj


def _evento_na_linha(con, eid):
    return con.execute("SELECT 1 FROM sup_linhas WHERE evento_id=?", (eid,)).fetchone()


def eventos_do_mes(con, mes):
    """Eventos do Relatório de eventos no mês, com os valores (R$) dos medidores: elétrica, água e gás."""
    return [dict(r) for r in con.execute("""
        SELECT e.id, e.nome, e.data, e.categoria,
               COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='ELÉTRICA'),0) AS energia,
               COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='ÁGUA'),0)     AS agua,
               COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='GÁS'),0)      AS gas
        FROM eventos e WHERE substr(e.data,1,7)=? ORDER BY e.data, e.nome""", (mes,))]


def _projeto_do_evento(con, nome, data):
    """Código do projeto do evento: projeto cadastrado cuja descrição tem o nome e a data (dd/mm) do evento."""
    dm = f"{data[8:10]}/{data[5:7]}"
    n = _norm(nome).replace(" x ", " x ")
    achados = [r["nome"] for r in con.execute("SELECT nome, descricao FROM bud_projetos")
               if dm in (r["descricao"] or "") and n and n in _norm(r["descricao"])]
    return achados[0] if len(set(achados)) == 1 else ""


def inserir_eventos(con, mes, so_novos=True):
    """Cria uma linha para cada evento do mês (valores dos medidores do Relatório de eventos). Nunca altera linhas que já
    existem: pula o evento que já tem linha (pelo vínculo ou por uma linha com a mesma data dd/mm no nome)."""
    cfg = config(con)
    existentes = [r["descricao"] or "" for r in con.execute("SELECT descricao FROM sup_linhas WHERE mes=?", (mes,))]
    novos = []
    for e in eventos_do_mes(con, mes):
        dm = f"{e['data'][8:10]}/{e['data'][5:7]}"
        if _evento_na_linha(con, e["id"]) or (so_novos and any(dm in x for x in existentes)):
            continue
        cc = cfg.get(CATEGORIA_CC.get((e["categoria"] or "").upper(), ""), "")
        desc = f"{e['nome']} - {dm}/{e['data'][2:4]}"
        ordem = con.execute("SELECT COALESCE(MAX(ordem),0)+1 FROM sup_linhas WHERE mes=?", (mes,)).fetchone()[0]
        con.execute("""INSERT INTO sup_linhas(mes, ordem, centro_custo, projeto, descricao, energia, agua, gas, evento_id, observacao)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (mes, ordem, cc, _projeto_do_evento(con, e["nome"], e["data"]), desc, round(e["energia"], 2), round(e["agua"], 2),
                     round(e["gas"], 2), e["id"], "valores do Relatório de eventos"))
        novos.append(desc)
    return novos


def grupo_da_linha(l, cfg):
    """Engenharia | show | jogo | projeto_especial | locatario (demais áreas: lojas, catering, estacionamento...)."""
    cc = l.get("centro_custo") or ""
    for g, k in (("show", "cc_show"), ("jogo", "cc_jogo"), ("projeto_especial", "cc_projeto_especial")):
        if cc and cc == cfg.get(k):
            return g
    if cc and cc == cfg.get("cc_engenharia"):
        return "engenharia"
    return "locatario"


def mes_anterior(mes):
    a, m = int(mes[:4]), int(mes[5:7])
    return f"{a - 1}-12" if m == 1 else f"{a}-{m - 1:02d}"


def tarifas(con, mes, cfg=None):
    """Tarifa usada nas linhas do mês (por padrão a da conta do mês anterior): {u: {tarifa, base, fatura, consumo, manual}}."""
    cfg = cfg or config(con)
    base = mes_anterior(mes) if cfg.get("tarifa_mes_anterior", "1") == "1" else mes
    out = {}
    for u in UKEYS:
        r = con.execute("SELECT * FROM sup_tarifas WHERE mes=? AND utilidade=?", (base, u)).fetchone()
        t = None
        if r:
            t = r["tarifa"] if r["tarifa"] else (r["fatura"] / r["consumo"] if r["fatura"] and r["consumo"] else None)
        out[u] = {"tarifa": t, "base": base, "fatura": r["fatura"] if r else None, "consumo": r["consumo"] if r else None,
                  "manual": bool(r and r["tarifa"]), "unidade": UNIDADE[u]}
    return out


def calcular(con, mes):
    """Contas, linhas com valor cobrado / descontado e a Engenharia (resto) de cada conta.
    Linha com consumo medido (kWh / m³): valor = consumo × tarifa do mês."""
    cfg = config(con)
    tar = tarifas(con, mes, cfg)
    contas = [dict(r) for r in con.execute("SELECT * FROM sup_contas WHERE mes=? ORDER BY utilidade, id", (mes,))]
    linhas = [dict(r) for r in con.execute("SELECT * FROM sup_linhas WHERE mes=? ORDER BY ordem, id", (mes,))]
    pm = con.execute("SELECT poco_valor, poco_m3, poco_separado FROM sup_meses WHERE mes=?", (mes,)).fetchone()
    # poço com coluna própria (padrão) ou somado à água do mês (a conta do poço vira mais uma conta de água, como Enel + Esfera)
    separado = not (pm and pm["poco_separado"] == 0)
    # conta de poço artesiano (fornecedor "Poço ..."): com coluna própria, não entra na água da Sabesp; é o total do poço do mês
    for c in contas:
        c["conta_poco"] = eh_conta_poco(c)
        c["eh_poco"] = c["conta_poco"] and separado
    total = {u: round(sum(c["valor"] or 0 for c in contas if c["utilidade"] == u and not c["eh_poco"]), 2) for u in UKEYS}
    # ---- medidores de cada linha: quantidade (kWh / m³), poço artesiano e % de cada conta
    # Eventos: quantidades e poço vêm do Relatório de eventos (pelo vínculo ou pela data dd/mm no nome da linha).
    # Poço artesiano não tem conta de concessionária: é mostrado à parte (R$ e m³) e o % é sobre o poço do mês.
    evs = {}
    for r in con.execute("""SELECT e.id, e.data, r.tipo, r.consumo, r.valor FROM eventos e JOIN relogios r ON r.evento_id = e.id
                            WHERE substr(e.data,1,7)=?""", (mes,)):
        ev = evs.setdefault(r["id"], {"data": r["data"], "med": {}})
        ev["med"][r["tipo"]] = (r["consumo"] or 0, r["valor"] or 0)
    def evento_da_linha(l):
        if l.get("evento_id") in evs:
            return evs[l["evento_id"]]
        achados = [e for e in evs.values() if f"{e['data'][8:10]}/{e['data'][5:7]}" in (l.get("descricao") or "")]
        return achados[0] if len(achados) == 1 else None
    TIPO = {"energia": "ELÉTRICA", "agua": "ÁGUA", "gas": "GÁS"}
    for l in linhas:
        ev = evento_da_linha(l)
        l["do_relatorio"] = bool(ev)
        l["qtd"] = {}
        for u in UKEYS:
            q = l.get(QCOL[u])
            l["qtd"][u] = q if q is not None else (ev["med"].get(TIPO[u], (None, 0))[0] if ev else None)
        pv, pq = l.get("poco"), l.get("poco_m3")
        if pv is None and ev:
            pq, pv = ev["med"].get("POÇO", (None, None))
        l["poco_manual"] = l.get("poco") is not None
        l["poco"] = round(pv or 0, 2)
        l["qtd"]["poco"] = pq
        l["poco_na_agua"] = 0.0
        if not separado:                 # poço somado à água: o valor do poço da linha entra na água (cobrado e %)
            l["poco_na_agua"], l["poco"], l["qtd"]["poco"] = l["poco"], 0.0, None
    rep = {u: 0.0 for u in UKEYS}
    desc = {u: 0.0 for u in UKEYS}
    sem_tarifa = set()
    for l in linhas:
        l["cobrado"], l["desconto"], l["por_consumo"] = {}, {}, {}
        for u in UKEYS:
            q = l.get(QCOL[u])
            if q is not None:
                l["por_consumo"][u] = True
                if tar[u]["tarifa"]:
                    l[u] = round(q * tar[u]["tarifa"], 2)
                else:
                    sem_tarifa.add(u)
            v = (l[u] or 0) + (l["poco_na_agua"] if u == "agua" else 0)
            d = round(v * (l["desc_pct"] or 0) / 100, 2) if l["desc_pct"] and l["desc_" + u] else 0.0
            l["cobrado"][u] = round(v - d, 2)
            l["desconto"][u] = d
            rep[u] += v - d
            desc[u] += d
        l["total"] = round(sum(l["cobrado"].values()), 2)
    eng = {u: round(total[u] - rep[u], 2) for u in UKEYS}
    # Poço do mês: total digitado no mês (R$ e m³) ou, sem ele, a soma do que foi medido (eventos / digitado nas linhas).
    poco_mes_v = pm["poco_valor"] if separado and pm and pm["poco_valor"] is not None else None
    poco_mes_q = pm["poco_m3"] if separado and pm and pm["poco_m3"] is not None else None
    contas_poco = [c for c in contas if c["eh_poco"]]
    if poco_mes_v is None and contas_poco:          # sem total digitado no quadro: usa a(s) conta(s) de poço do mês
        poco_mes_v = round(sum(c["valor"] or 0 for c in contas_poco), 2)
    # Poço: eventos usam o do Relatório de eventos; locatários e áreas, o valor digitado na linha (sem cálculo automático).
    # Engenharia = total do mês (NF do poço, digitado) − o que foi para as linhas.
    medido_v = round(sum(l["poco"] for l in linhas), 2)
    medido_q = round(sum(l["qtd"]["poco"] or 0 for l in linhas), 3)
    base_v = poco_mes_v if poco_mes_v else medido_v
    for l in linhas:
        l["pct"] = {u: (round(100 * l["cobrado"][u] / total[u], 2) if total[u] else None) for u in UKEYS}
        l["pct"]["poco"] = round(100 * l["poco"] / base_v, 2) if base_v and l["poco"] else None
        l["poco_estimado"] = False
    total_poco, total_poco_m3 = medido_v, medido_q
    eng_poco = round(poco_mes_v - total_poco, 2) if poco_mes_v is not None else None
    eng_poco_m3 = round(poco_mes_q - total_poco_m3, 3) if poco_mes_q is not None else None
    resto_v = None
    eng_pct = {u: (round(100 * eng[u] / total[u], 2) if total[u] else None) for u in UKEYS}
    eng_pct["poco"] = round(100 * eng_poco / poco_mes_v, 2) if eng_poco is not None and poco_mes_v else None
    # parte da Engenharia de cada conta (proporcional ao valor da conta no total do tipo) e onde ela entra no budget
    partes = {}
    try:
        for r in con.execute("""SELECT r.conta_id, r.item_id, r.pct, i.centro_custo, i.projeto, i.classe_numero, i.classe_descricao
                                FROM sup_conta_rateio r JOIN bud_itens i ON i.id = r.item_id
                                WHERE r.conta_id IN (SELECT id FROM sup_contas WHERE mes=?) ORDER BY r.id""", (mes,)):
            partes.setdefault(r["conta_id"], []).append(dict(r))
    except Exception:
        pass
    no_budget = set()
    try:
        no_budget = {r[0] for r in con.execute("SELECT item_id FROM bud_previsto WHERE ano=?", (int(mes[:4]),))}
    except Exception:
        pass
    tot_contas_poco = sum(c["valor"] or 0 for c in contas_poco)
    for c in contas:
        u = c["utilidade"]
        # parte da Engenharia = a mesma Engenharia (resto) do Rateio; com mais de uma conta do tipo, dividida pelo valor de cada uma
        if c["eh_poco"]:
            c["eng_calculada"] = round(max(eng_poco or 0, 0) * (c["valor"] or 0) / tot_contas_poco, 2) if tot_contas_poco and eng_poco is not None else 0.0
        else:
            c["eng_calculada"] = round(max(eng[u], 0) * (c["valor"] or 0) / total[u], 2) if total[u] else 0.0
        c["eng_manual"] = False
        c["eng_parte"] = c["eng_calculada"]
        c["budget"] = [{**p, "valor": round(c["eng_parte"] * p["pct"] / 100, 2), "no_budget": p["item_id"] in no_budget}
                       for p in partes.get(c["id"], [])]
        c["budget_pct"] = round(sum(p["pct"] for p in c["budget"]), 4)
    return {
        "mes": mes, "contas": contas, "linhas": linhas, "poco_separado": separado,
        "poco_na_agua": round(sum(l["poco_na_agua"] for l in linhas), 2),
        "poco_conta_na_agua": round(sum(c["valor"] or 0 for c in contas if c["conta_poco"] and not separado), 2),
        "totais": {"contas": total, "repassado": {u: round(rep[u], 2) for u in UKEYS},
                   "descontos": {u: round(desc[u], 2) for u in UKEYS}, "engenharia": eng, "engenharia_pct": eng_pct,
                   "poco": total_poco, "poco_m3": total_poco_m3, "poco_mes": poco_mes_v, "poco_mes_m3": poco_mes_q,
                   "poco_medido": medido_v, "poco_engenharia": eng_poco, "poco_engenharia_m3": eng_poco_m3,
                   "poco_da_conta": bool(contas_poco) and (pm is None or pm["poco_valor"] is None),
                   "poco_medido_maior": poco_mes_v is not None and medido_v > poco_mes_v + 0.005},
        "engenharia": {"centro_custo": cfg["cc_engenharia"], "projeto": cfg["projeto_engenharia"]},
        "tarifas": tar,
        "avisos": [f"{nome}: há linhas com consumo medido, mas falta a tarifa (conta de {tar[u]['base'][5:]}/{tar[u]['base'][:4]}). "
                   "Preencha em Tarifas do mês." for u, nome in UTIL if u in sem_tarifa] + [f"{nome}: o que foi repassado passa o valor das contas (Engenharia negativa)." for u, nome in UTIL if eng[u] < -0.005]
                  + [f"{nome}: há valores nas linhas, mas nenhuma conta lançada." for u, nome in UTIL if rep[u] and not total[u]],
    }


def lancamentos_budget(con, ano=None, item=None, mes=None):
    """Parte da Engenharia das contas de consumo que vai para o budget: uma entrada por conta x linha do budget.
    Data = 1º dia do mês de competência da conta."""
    try:
        q = "SELECT DISTINCT c.mes FROM sup_conta_rateio r JOIN sup_contas c ON c.id = r.conta_id"
        meses = [r[0] for r in con.execute(q)]
    except Exception:
        return []
    out = []
    for m in sorted(meses):
        if ano and not m.startswith(str(ano)):
            continue
        if mes and m != mes:
            continue
        d = calcular(con, m)
        for c in d["contas"]:
            for p in c["budget"]:
                if item and p["item_id"] != item:
                    continue
                out.append({"tipo": "CONSUMO", "id": c["id"], "mes": m, "data": f"{m}-01", "valor": p["valor"], "item_id": p["item_id"],
                            "pct": p["pct"], "utilidade": c["utilidade"], "fornecedor": (c["fornecedor"] or "").strip().upper(),
                            "ref": f"Conta de {dict(UTIL)[c['utilidade']].lower()} {c['fornecedor'] or ''} {m[5:]}/{m[:4]}"
                                   f"{' · doc ' + c['numero_doc'] if c.get('numero_doc') else ''}".strip()})
    return out


def _copiar_budget_conta(con, cid):
    """Conta nova: usa a mesma divisão no budget da última conta do mesmo tipo e fornecedor."""
    c = con.execute("SELECT * FROM sup_contas WHERE id=?", (cid,)).fetchone()
    if not c:
        return 0
    ant = con.execute("""SELECT id FROM sup_contas WHERE utilidade=? AND id<>? AND mes<=? AND id IN (SELECT conta_id FROM sup_conta_rateio)
                         AND LOWER(TRIM(COALESCE(fornecedor,''))) = LOWER(TRIM(?)) ORDER BY mes DESC, id DESC LIMIT 1""",
                      (c["utilidade"], cid, c["mes"], c["fornecedor"] or "")).fetchone() or \
        con.execute("""SELECT id FROM sup_contas WHERE utilidade=? AND id<>? AND mes<=? AND id IN (SELECT conta_id FROM sup_conta_rateio)
                       ORDER BY mes DESC, id DESC LIMIT 1""", (c["utilidade"], cid, c["mes"])).fetchone()
    if not ant:
        return 0
    return con.execute("INSERT INTO sup_conta_rateio(conta_id, item_id, pct) SELECT ?, item_id, pct FROM sup_conta_rateio WHERE conta_id=?",
                       (cid, ant[0])).rowcount


def resumo(con, ano=None):
    meses = [r[0] for r in con.execute("SELECT mes FROM sup_meses UNION SELECT mes FROM sup_contas UNION SELECT mes FROM sup_linhas ORDER BY 1 DESC")]
    out = []
    for m in meses:
        if ano and not m.startswith(str(ano)):
            continue
        c = calcular(con, m)
        out.append({"mes": m, **c["totais"], "n_linhas": len(c["linhas"]), "n_contas": len(c["contas"])})
    return out


# ----------------------------------------------------------------------------- importação
def _ler(caminho, so=None):
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(caminho))
    return {n: wb.get_sheet_by_name(n).to_python() for n in wb.sheet_names if so is None or so(n)}


def importar_bases(con, caminho):
    """Planilha de consumos dos locatários: abas 'Supri- Energia Elétrica', 'Supri- Água' e 'Supri- Gás Natural' com a
    conta e o consumo de cada mês (base da tarifa). Grava em sup_tarifas (atualiza os meses que já existiam)."""
    abas = _ler(caminho, lambda n: _norm(n).startswith("supri"))
    regras = {"energia": (("consumo total",), ("fatura total",)),
              "agua": (("consumo sabesp",), ("fatura",)),
              "gas": (("consumo comgas",), ("fornecimento de gn", "fatura"))}
    res = {"tarifas": 0, "meses": set(), "avisos": []}
    for nome, ws in abas.items():
        u = utilidade_de(nome)
        if not u:
            continue
        cab_i = next((i for i, r in enumerate(ws[:10]) if any(_norm(x).startswith("mes competencia") for x in r)), None)
        if cab_i is None:
            res["avisos"].append(f"{nome}: não achei o cabeçalho 'Mês Competência'."); continue
        cab = [_norm(x) for x in ws[cab_i]]
        achar = lambda chaves: next((j for j, c in enumerate(cab) for k in chaves if c == k or c.startswith(k)), None)
        cq, cf = achar(regras[u][0]), achar(regras[u][1])
        if cq is None or cf is None:
            res["avisos"].append(f"{nome}: faltam as colunas de consumo e de fatura."); continue
        for r in ws[cab_i + 1:]:
            mes = importer.data_iso(r[0])[:7] if r and r[0] not in (None, "") else ""
            q = importer.num(r[cq] if cq < len(r) else None)
            f = importer.num(r[cf] if cf < len(r) else None)
            if not mes or not q or not f:
                continue
            con.execute("""INSERT INTO sup_tarifas(mes, utilidade, fatura, consumo) VALUES (?,?,?,?)
                           ON CONFLICT(mes, utilidade) DO UPDATE SET fatura=excluded.fatura, consumo=excluded.consumo""", (mes, u, f, q))
            res["tarifas"] += 1
            res["meses"].add(mes)
    res["meses"] = sorted(res["meses"])
    return res


def _mapa_codigos(abas):
    """Nome -> código de centro de custo e de projeto, lidos da aba de listas (pares 'Centro de custo / Cod. CC',
    'Projeto / Cod. Projeto') da planilha do requisitante."""
    cc, pj = {}, {}
    for nome, ws in abas.items():
        for i, row in enumerate(ws):
            for j in range(len(row) - 1):
                a, b = _norm(row[j]), _norm(row[j + 1])
                if a == "centro de custo" and b.startswith("cod"):
                    alvo = cc
                elif a.startswith("projeto") and b.startswith("cod"):
                    alvo = pj
                else:
                    continue
                for r in ws[i + 1:]:
                    if j + 1 >= len(r) or r[j] in (None, "") or _norm(r[j]) in ("projeto", "centro de custo"):
                        break
                    cod = importer.txt(r[j + 1])
                    if cod:
                        alvo[_norm(r[j])] = cod.split(".")[0]
    return cc, pj


def _codigo(con, valor, mapa, tabela):
    """Código do centro de custo / projeto: já é número, está na lista da planilha ou na descrição dos cadastros."""
    t = importer.txt(valor)
    if not t:
        return "", ""
    if re.match(r"^\d+(\.0)?$", t):
        return t.split(".")[0], ""
    if _norm(t) in mapa:
        return mapa[_norm(t)], t
    # evento abreviado: 'BANDA X - 13/09/26' acha 'SHOW ARENA - BANDA X - 13/09/2026'
    m = re.match(r"^(.*?)\s*-\s*(\d{1,2}/\d{1,2})(?:/\d{2,4})?\s*$", t)
    if m:
        nome, dia = _norm(m.group(1)), m.group(2)
        dia = "/".join(x.zfill(2) for x in dia.split("/"))
        achados = [cod for k, cod in mapa.items() if nome and nome in k and dia in k]
        if len(set(achados)) == 1:
            return achados[0], t
    for r in con.execute(f"SELECT nome, descricao FROM {tabela}"):
        if _norm(r["descricao"]) == _norm(t):
            return r["nome"], t
    return "", t


def _datas_texto(txt):
    """'Enel - 06/05/26; Esfera - 01/05/26' -> {'enel': '2026-05-06', 'esfera': '2026-05-01'}"""
    out = {}
    for parte in re.split(r"[;\n]", str(txt or "")):
        m = re.search(r"(\d{1,2}/\d{1,2}/\d{2,4})", parte)
        if not m:
            continue
        d = importer.data_iso(m.group(1))
        for nome in re.split(r"[/,+]", parte[:m.start()]):
            n = _norm(nome).strip(" -:")
            if n:
                out[n] = d
    return out


def _data_para(datas, fornecedor, valor_cel):
    if valor_cel not in (None, "") and not isinstance(valor_cel, str):
        return importer.data_iso(valor_cel)
    for nome in re.split(r"[+/,]", fornecedor or ""):
        n = _norm(nome)
        for k, v in datas.items():
            if n and (n in k or k in n):
                return v
    return next(iter(datas.values()), "") if len(datas) == 1 else ""


def importar_planilha(con, caminho, mes_padrao="", modo="substituir"):
    """Aceita a planilha do requisitante (aba com 'Centro de custo | Projeto | Quantidade Energia...') e a base
    exportada pelo site (abas RATEIO e CONTAS). modo: substituir (apaga linhas e contas dos meses importados) ou acrescentar."""
    from python_calamine import CalamineWorkbook
    nomes = CalamineWorkbook.from_path(str(caminho)).sheet_names
    if any(_norm(n).startswith("supri") for n in nomes) and not any(n.upper() in ("RATEIO", "PLANILHA REQUISITANTE") for n in nomes):
        b = importar_bases(con, caminho)       # planilha de consumos: só a base das tarifas
        return {"meses": [], "linhas": 0, "contas": 0, "tarifas": b["tarifas"], "meses_tarifa": b["meses"], "avisos": b["avisos"]}
    abas = _ler(caminho)
    res = {"meses": [], "linhas": 0, "contas": 0, "avisos": []}
    novas_linhas, novas_contas = [], []

    def achar_cab(ws, *chaves):
        for i, row in enumerate(ws[:15]):
            rn = [_norm(x) for x in row]
            if all(any(k in c for c in rn) for k in chaves):
                return i, rn
        return None, None

    # ---- base do site (RATEIO / CONTAS)
    base = {n.upper(): ws for n, ws in abas.items()}
    g = lambda r, j: r[j] if j is not None and j < len(r) else None
    if "RATEIO" in base or "CONTAS" in base:
      if "RATEIO" in base:   # (só a aba CONTAS também vale: importa só as contas)
        ws = base["RATEIO"]
        i, cab = achar_cab(ws, "mes", "centro de custo", "energia")
        if i is None:
            abort(400, "Aba RATEIO sem o cabeçalho esperado (MÊS, CENTRO DE CUSTO, ..., ENERGIA).")
        col = lambda *ks: next((j for j, c in enumerate(cab) if all(k in c for k in ks)), None)
        c_mes, c_cc, c_ccd, c_pj, c_pjd = col("mes"), col("centro de custo", "(n"), col("centro de custo", "descr"), col("projeto", "(n"), col("projeto", "descr")
        c_desc, c_e, c_a, c_g = col("linha"), col("energia"), col("agua"), col("gas")
        c_pct, c_de, c_da, c_dg, c_obs = col("desconto", "%"), col("desc", "energia"), col("desc", "agua"), col("desc", "gas"), col("observ")
        # as colunas "DESCONTO EM ..." também contêm "energia": separa pelo cabeçalho exato
        c_e = next((j for j, c in enumerate(cab) if c.startswith("energia")), c_e)
        c_a = next((j for j, c in enumerate(cab) if c.startswith("agua")), c_a)
        c_g = next((j for j, c in enumerate(cab) if c.startswith("gas")), c_g)
        g = lambda r, j: r[j] if j is not None and j < len(r) else None
        sim = lambda v: _norm(v) in ("s", "sim", "x", "1", "true", "verdadeiro")
        for n, r in enumerate(ws[i + 1:], i + 2):
            if not any(x not in (None, "") for x in r):
                continue
            m = importer.txt(g(r, c_mes))[:7]
            if re.match(r"^\d{4}-\d{2}-\d{2}", importer.data_iso(g(r, c_mes)) or ""):
                m = importer.data_iso(g(r, c_mes))[:7]
            m = m or mes_padrao
            if not re.match(r"^\d{4}-\d{2}$", m or ""):
                res["avisos"].append(f"RATEIO linha {n}: sem mês (AAAA-MM). Ignorada."); continue
            if _norm(g(r, c_desc)) in ("engenharia (resto)", "parte da engenharia"):
                continue
            cc = importer.txt(g(r, c_cc)).split(".")[0]
            pj = importer.txt(g(r, c_pj)).split(".")[0]
            ccd, pjd = importer.txt(g(r, c_ccd)), importer.txt(g(r, c_pjd))
            novas_linhas.append({"mes": m, "centro_custo": cc, "projeto": pj, "descricao": importer.txt(g(r, c_desc)) or pjd,
                                 "energia": importer.num(g(r, c_e)), "agua": importer.num(g(r, c_a)), "gas": importer.num(g(r, c_g)),
                                 "desc_pct": importer.num(g(r, c_pct)), "desc_energia": int(sim(g(r, c_de))), "desc_agua": int(sim(g(r, c_da))),
                                 "desc_gas": int(sim(g(r, c_dg))), "observacao": importer.txt(g(r, c_obs)), "_ccd": ccd, "_pjd": pjd})
      if "CONTAS" in base:
          ws = base["CONTAS"]
          i, cab = achar_cab(ws, "mes", "valor")
          if i is not None:
              col = lambda *ks: next((j for j, c in enumerate(cab) if all(k in c for k in ks)), None)
              cm, cu, cf, ce, cv, cval, co = col("mes"), col("conta"), col("fornecedor"), col("emiss"), col("venc"), col("valor"), col("observ")
              cn = next((j for j, c in enumerate(cab) if "doc" in c), None)
              for n, r in enumerate(ws[i + 1:], i + 2):
                  if not any(x not in (None, "") for x in r):
                      continue
                  m = importer.txt(g(r, cm))[:7] or mes_padrao
                  u = utilidade_de(g(r, cu)) or utilidade_de(g(r, cf))
                  if not re.match(r"^\d{4}-\d{2}$", m or "") or not u:
                      res["avisos"].append(f"CONTAS linha {n}: falta mês ou conta (energia / água / gás). Ignorada."); continue
                  novas_contas.append({"mes": m, "utilidade": u, "fornecedor": importer.txt(g(r, cf)), "numero_doc": importer.txt(g(r, cn)),
                                       "data_emissao": importer.data_iso(g(r, ce)), "data_vencimento": importer.data_iso(g(r, cv)),
                                       "valor": importer.num(g(r, cval)), "observacao": importer.txt(g(r, co))})
    else:
        # ---- planilha do requisitante
        alvo = None
        for nome, ws in abas.items():
            for i, row in enumerate(ws[:20]):
                rn = [_norm(x) for x in row]
                if len(rn) > 1 and rn[0] == "centro de custo" and rn[1].startswith("projeto"):
                    alvo = (nome, ws, i, rn)
                    break
            if alvo:
                break
        if not alvo:
            abort(400, "Não reconheci a planilha: falta a aba RATEIO (base do site) ou a linha 'Centro de custo | Projeto | Quantidade Energia...' (planilha do requisitante).")
        if not mes_padrao:
            abort(400, "Escolha o mês (competência) dessa planilha.")
        _, ws, i, cab = alvo
        mapa_cc, mapa_pj = _mapa_codigos(abas)
        cols = {}
        for j, c in enumerate(cab):
            u = utilidade_de(c) if j >= 2 else None
            if u and u not in cols:
                cols[u] = j
        c_obs = next((j for j, c in enumerate(cab) if c.startswith("observ")), None)
        # totais das contas: linha logo acima do cabeçalho; fornecedores: nomes na primeira linha
        if i >= 2:
            nomes, valores = ws[0], ws[i - 1]
            datas_em = _datas_texto(valores[0] if valores else "")
            datas_ve = _datas_texto(valores[1] if len(valores) > 1 else "")
            for u, j in cols.items():
                v = importer.num(valores[j] if j < len(valores) else None)
                forn = importer.txt(nomes[j] if j < len(nomes) else "") or dict(UTIL)[u]
                if v:
                    novas_contas.append({"mes": mes_padrao, "utilidade": u, "fornecedor": forn, "numero_doc": "",
                                         "data_emissao": _data_para(datas_em, forn, None), "data_vencimento": _data_para(datas_ve, forn, None),
                                         "valor": v, "observacao": ""})
        for n, r in enumerate(ws[i + 1:], i + 2):
            cc_t = importer.txt(r[0] if r else "")
            pj_t = importer.txt(r[1] if len(r) > 1 else "")
            vals = {u: importer.num(r[j] if j < len(r) else None) for u, j in cols.items()}
            if not cc_t and not pj_t:
                continue
            if _norm(cc_t) == "engenharia" and (not pj_t or _norm(pj_t) == "engenharia"):
                continue   # a Engenharia é o resto: o site calcula
            if not pj_t and not any(vals.values()):
                continue   # centro de custo sem projeto e sem valor (linha só de título)
            novas_linhas.append({"mes": mes_padrao, "centro_custo": cc_t, "projeto": pj_t, "descricao": pj_t or cc_t,
                                 "energia": vals.get("energia", 0), "agua": vals.get("agua", 0), "gas": vals.get("gas", 0),
                                 "desc_pct": 0, "desc_energia": 0, "desc_agua": 0, "desc_gas": 0,
                                 "observacao": importer.txt(r[c_obs]) if c_obs is not None and c_obs < len(r) else "",
                                 "_mapas": (mapa_cc, mapa_pj)})

    # ---- códigos de centro de custo / projeto + cadastros
    sem_cod = set()
    for l in novas_linhas:
        mapa_cc, mapa_pj = l.pop("_mapas", ({}, {}))
        cc, ccd = _codigo(con, l["centro_custo"], mapa_cc, "bud_centros")
        pj, pjd = _codigo(con, l["projeto"], mapa_pj, "bud_projetos")
        ccd, pjd = l.pop("_ccd", "") or ccd, l.pop("_pjd", "") or pjd
        l["centro_custo"], l["projeto"] = cc, pj
        if cc:
            con.execute("INSERT OR IGNORE INTO bud_centros(nome, descricao) VALUES (?,?)", (cc, ccd))
            if ccd:
                con.execute("UPDATE bud_centros SET descricao=? WHERE nome=? AND COALESCE(descricao,'')=''", (ccd, cc))
        if pj:
            con.execute("INSERT OR IGNORE INTO bud_projetos(nome, descricao, centro_custo) VALUES (?,?,?)", (pj, pjd, cc))
            if pjd:
                con.execute("UPDATE bud_projetos SET descricao=? WHERE nome=? AND COALESCE(descricao,'')=''", (pjd, pj))
        if not cc or not pj:
            sem_cod.add(l["descricao"] or ccd or pjd)
    if sem_cod:
        res["avisos"].append(f"{len(sem_cod)} linha(s) sem código de centro de custo ou projeto (escolha na tela antes de exportar para o Suprimentos): "
                             + ", ".join(sorted(sem_cod))[:400])

    meses = sorted({x["mes"] for x in novas_linhas} | {x["mes"] for x in novas_contas})
    guardado = {}   # divisão no budget das contas que vão ser substituídas: volta para a conta nova do mesmo tipo e fornecedor
    for m in meses:
        con.execute("INSERT OR IGNORE INTO sup_meses(mes) VALUES (?)", (m,))
        if modo == "substituir":
            if any(x["mes"] == m for x in novas_linhas):
                con.execute("DELETE FROM sup_linhas WHERE mes=?", (m,))
            if any(x["mes"] == m for x in novas_contas):
                for r in con.execute("""SELECT c.utilidade, c.fornecedor, r.item_id, r.pct FROM sup_conta_rateio r
                                        JOIN sup_contas c ON c.id = r.conta_id WHERE c.mes=?""", (m,)).fetchall():
                    guardado.setdefault((m, r["utilidade"], _norm(r["fornecedor"])), []).append((r["item_id"], r["pct"]))
                con.execute("DELETE FROM sup_conta_rateio WHERE conta_id IN (SELECT id FROM sup_contas WHERE mes=?)", (m,))
                con.execute("DELETE FROM sup_contas WHERE mes=?", (m,))
    for k, l in enumerate(novas_linhas):
        base_ordem = con.execute("SELECT COALESCE(MAX(ordem),0) FROM sup_linhas WHERE mes=?", (l["mes"],)).fetchone()[0]
        con.execute("""INSERT INTO sup_linhas(mes, ordem, centro_custo, projeto, descricao, energia, agua, gas, desc_pct,
                       desc_energia, desc_agua, desc_gas, observacao) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (l["mes"], base_ordem + 1, l["centro_custo"], l["projeto"], l["descricao"], l["energia"], l["agua"], l["gas"],
                     l["desc_pct"], l["desc_energia"], l["desc_agua"], l["desc_gas"], l["observacao"]))
    for c in novas_contas:
        cid = con.execute("""INSERT INTO sup_contas(mes, utilidade, fornecedor, numero_doc, data_emissao, data_vencimento, valor, observacao)
                       VALUES (?,?,?,?,?,?,?,?)""", (c["mes"], c["utilidade"], c["fornecedor"], c["numero_doc"], c["data_emissao"],
                                                      c["data_vencimento"], c["valor"], c["observacao"])).lastrowid
        antes = guardado.pop((c["mes"], c["utilidade"], _norm(c["fornecedor"])), None)
        if antes:
            con.executemany("INSERT INTO sup_conta_rateio(conta_id, item_id, pct) VALUES (?,?,?)", [(cid, i, p) for i, p in antes])
        else:
            _copiar_budget_conta(con, cid)
    res.update(meses=meses, linhas=len(novas_linhas), contas=len(novas_contas))
    return res


# ----------------------------------------------------------------------------- exportação
def _codigos_erp(agente):
    a = str(agente)
    return {
        "cod_item": "903" if a == "7003" else "901" if a == "7001" else "902",
        "aplicacao": "801" if a in ("7002", "7003") else "802",
        "tipo_classe": "702" if a == "7002" else "701" if a == "7001" else "703",
        "cfop": 1933 if a in ("7003", "7002") else 1253,
        "serie": "-" if a in ("7002", "7003") else "3",
    }


def gerar_excel(con, mes=None, ano=None, modelo=False):
    import exporter
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    wb = Workbook(); wb.remove(wb.active)
    cfg = config(con)
    dcc, dpj = descricoes(con)
    BRL, DATA = exporter.BRL, exporter.DATA
    if modelo:
        meses = []
    elif mes:
        meses = [mes]
    else:
        meses = [r["mes"] for r in resumo(con, ano)][::-1]
    dados = {m: calcular(con, m) for m in meses}
    sn = lambda v: "SIM" if v else "NÃO"

    # ---- base do site (importa de volta). Valores digitados ficam como valor; o que é calculado vai como FÓRMULA:
    # cobrado (com desconto), Engenharia (total das contas da aba CONTAS − repassado), poço da Engenharia e os %.
    ws = wb.create_sheet("RATEIO")
    cab = ["MÊS (AAAA-MM)", "LINHA", "CENTRO DE CUSTO (Nº)", "CENTRO DE CUSTO (DESCRIÇÃO)", "PROJETO (Nº)", "PROJETO (DESCRIÇÃO)",
           "ENERGIA (R$)", "ÁGUA (R$)", "GÁS (R$)", "DESCONTO (%)", "DESCONTO EM ENERGIA", "DESCONTO EM ÁGUA", "DESCONTO EM GÁS",
           "OBSERVAÇÃO", "COBRADO ENERGIA (R$)", "COBRADO ÁGUA (R$)", "COBRADO GÁS (R$)", "POÇO ARTESIANO (R$)",
           "% DA CONTA DE ENERGIA", "% DA CONTA DE ÁGUA", "% DA CONTA DE GÁS", "% DO POÇO DO MÊS"]
    exporter._faixa(ws, len(cab), "Suprimentos · rateio das contas de consumo",
                    "Uma linha por centro de custo + projeto. Cobrado, Parte da Engenharia e % são fórmulas: mudando um valor, a planilha recalcula.")
    TIPO_CONTA = {"energia": "ENERGIA ELÉTRICA", "agua": "ÁGUA", "gas": "GÁS"}
    linhas, r = [], 5
    for m in meses:
        d = dados[m]
        ini = r
        for l in d["linhas"]:
            cob = [f'=ROUND({c}{r}*(1-IF({f}{r}="SIM",N(J{r})/100,0)),2)' for c, f in (("G", "K"), ("H", "L"), ("I", "M"))]
            if not d["poco_separado"]:   # poço somado à água: o poço da linha (coluna R) entra no cobrado da água
                cob[1] = f'=ROUND((H{r}+N(R{r}))*(1-IF(L{r}="SIM",N(J{r})/100,0)),2)'
            pct = [f'=IFERROR({c}{r}/SUMIFS(CONTAS!$G:$G,CONTAS!$A:$A,$A{r},CONTAS!$B:$B,"{TIPO_CONTA[u]}"),"")' for c, u in (("O", "energia"), ("P", "agua"), ("Q", "gas"))]
            linhas.append([m, l["descricao"], l["centro_custo"], dcc.get(l["centro_custo"], ""), l["projeto"], dpj.get(l["projeto"], ""),
                           l["energia"], l["agua"], l["gas"], l["desc_pct"] or None, sn(l["desc_energia"]), sn(l["desc_agua"]), sn(l["desc_gas"]),
                           l["observacao"], *cob, (l.get("poco") or l.get("poco_na_agua")) or None, *pct, f'=IFERROR(R{r}/SUMIFS($R:$R,$A:$A,$A{r}),"")' if d["poco_separado"] else None])
            r += 1
        fim = r - 1
        t = d["totais"]
        eng_val = [f'=SUMIFS(CONTAS!$G:$G,CONTAS!$A:$A,$A{r},CONTAS!$B:$B,"{TIPO_CONTA[u]}")' + (f"-SUM({c}{ini}:{c}{fim})" if fim >= ini else "")
                   for c, u in (("O", "energia"), ("P", "agua"), ("Q", "gas"))]
        poco_eng = (f"={t['poco_mes']}" + (f"-SUM(R{ini}:R{fim})" if fim >= ini else "")) if t.get("poco_mes") is not None else None
        pct = [f'=IFERROR({c}{r}/SUMIFS(CONTAS!$G:$G,CONTAS!$A:$A,$A{r},CONTAS!$B:$B,"{TIPO_CONTA[u]}"),"")' for c, u in (("O", "energia"), ("P", "agua"), ("Q", "gas"))]
        linhas.append([m, "Parte da Engenharia", cfg["cc_engenharia"], dcc.get(cfg["cc_engenharia"], ""), cfg["projeto_engenharia"],
                       dpj.get(cfg["projeto_engenharia"], ""), f"=O{r}", f"=P{r}", f"=Q{r}", None, "", "", "",
                       "calculado: total das contas (aba CONTAS) − repassado", *eng_val, poco_eng, *pct,
                       f'=IFERROR(R{r}/SUMIFS($R:$R,$A:$A,$A{r}),"")' if poco_eng else None])
        r += 1
    if modelo:
        linhas = [["2026-09", "Loja Exemplo", "140", "Locações", "9100", "Loja Exemplo", 500.00, 250.00, 0, None, "NÃO", "NÃO", "NÃO", "", None, None, None, None, None, None, None, None],
                  ["2026-09", "TIME A x TIME B - 04/09/26", "102", "Jogos", "", "", 8000.00, 5000.00, 700.00, 20, "SIM", "NÃO", "NÃO", "desconto de 20% só na energia", None, None, None, None, None, None, None, None]]
    PCT = "0.00%"
    exporter._tabela(ws, "tbRateio", cab, linhas or [[None] * len(cab)], [None] * 6 + [BRL] * 3 + ['0.00"%"'] + [None] * 4 + [BRL] * 4 + [PCT] * 4,
                     [11, 30, 12, 22, 11, 30, 14, 14, 14, 11, 11, 11, 11, 34, 15, 15, 15, 15, 12, 12, 12, 12])
    for rr in range(5, 5 + len(linhas)):
        if ws.cell(rr, 2).value == "Parte da Engenharia":
            for c in range(1, len(cab) + 1):
                ws.cell(rr, c).font = Font(bold=True, color="1E002F")
                ws.cell(rr, c).fill = PatternFill("solid", fgColor="EDE3FB")

    ws = wb.create_sheet("CONTAS")
    exporter._faixa(ws, 8, "Contas das concessionárias", "Energia elétrica, água e gás de cada mês (podem ser várias contas por mês, ex.: Enel + Esfera)")
    cab = ["MÊS (AAAA-MM)", "CONTA (ENERGIA / ÁGUA / GÁS)", "FORNECEDOR", "Nº DOCUMENTO", "EMISSÃO", "VENCIMENTO", "VALOR (R$)", "OBSERVAÇÃO"]
    nome_u = dict(UTIL)
    lc = [[m, "POÇO ARTESIANO" if c.get("eh_poco") else nome_u[c["utilidade"]].upper(), c["fornecedor"], c["numero_doc"], importer.data_iso(c["data_emissao"]) and dt.date.fromisoformat(c["data_emissao"]),
           c["data_vencimento"] and dt.date.fromisoformat(c["data_vencimento"]), c["valor"], c["observacao"]] for m in meses for c in dados[m]["contas"]]
    if modelo:
        lc = [["2026-09", "ENERGIA ELÉTRICA", "Enel", "123456", dt.date(2026, 10, 6), dt.date(2026, 10, 27), 173677.92, ""],
              ["2026-09", "ENERGIA ELÉTRICA", "Esfera", "", dt.date(2026, 10, 1), dt.date(2026, 10, 27), 143909.76, ""],
              ["2026-09", "ÁGUA", "Sabesp", "", dt.date(2026, 10, 15), dt.date(2026, 10, 27), 75670.08, ""],
              ["2026-09", "GÁS", "Comgás", "", None, dt.date(2026, 10, 24), 18502.55, ""]]
    exporter._tabela(ws, "tbContas", cab, lc or [[None] * len(cab)], [None, None, None, None, DATA, DATA, BRL, None], [11, 22, 22, 16, 12, 12, 16, 34])

    # ---- resumo por mês
    if len(meses) > 1:
        ws = wb.create_sheet("RESUMO")
        exporter._faixa(ws, 13, "Resumo por mês", "Total das contas, repassado às áreas, descontos e Parte da Engenharia")
        cab = ["MÊS"] + [f"{t} {n.upper()} (R$)" for t in ("CONTAS", "REPASSADO", "ENGENHARIA") for _, n in UTIL] + ["DESCONTOS (R$)", "TOTAL CONTAS (R$)", "TOTAL ENGENHARIA (R$)"]
        lr = []
        TIPO_CONTA = {"energia": "ENERGIA ELÉTRICA", "agua": "ÁGUA", "gas": "GÁS"}
        COB = {"energia": "O", "agua": "P", "gas": "Q"}
        for k, m in enumerate(meses):
            rr = 5 + k
            contas_f = [f'=SUMIFS(CONTAS!$G:$G,CONTAS!$A:$A,$A{rr},CONTAS!$B:$B,"{TIPO_CONTA[u]}")' for u in UKEYS]
            rep_f = [f'=SUMIFS(RATEIO!${COB[u]}:${COB[u]},RATEIO!$A:$A,$A{rr},RATEIO!$B:$B,"<>Parte da Engenharia")' for u in UKEYS]
            eng_f = [f"={a}{rr}-{b}{rr}" for a, b in (("B", "E"), ("C", "F"), ("D", "G"))]
            desc_f = (f"=SUMPRODUCT((RATEIO!$A$5:$A$5000=$A{rr})*(RATEIO!$G$5:$G$5000+RATEIO!$H$5:$H$5000+RATEIO!$I$5:$I$5000"
                      f"-RATEIO!$O$5:$O$5000-RATEIO!$P$5:$P$5000-RATEIO!$Q$5:$Q$5000)*(RATEIO!$B$5:$B$5000<>\"Parte da Engenharia\"))")
            lr.append([m, *contas_f, *rep_f, *eng_f, desc_f, f"=SUM(B{rr}:D{rr})", f"=SUM(H{rr}:J{rr})"])
        exporter._tabela(ws, "tbResumo", cab, lr, [None] + [BRL] * 12, [10] + [15] * 12)

    # ---- planilha do requisitante e do Suprimentos (um mês)
    if mes and not modelo:
        d = dados[mes]
        _requisitante(wb, d, cfg, dcc, dpj)
        for u, nome in UTIL:
            if d["totais"]["contas"][u] or any(l[u] for l in d["linhas"]):
                _suprimentos(wb, d, u, nome, cfg, dcc, dpj)
    buf = BytesIO(); wb.save(buf); buf.seek(0)
    return buf


def _requisitante(wb, d, cfg, dcc, dpj):
    """Mesmo formato da planilha do requisitante: totais das contas no topo, linhas e a Engenharia (fórmula) no fim."""
    from openpyxl.styles import Alignment, Font, PatternFill
    ws = wb.create_sheet("Planilha requisitante")
    contas = d["contas"]
    forn = {u: " + ".join(c["fornecedor"] for c in contas if c["utilidade"] == u and c["fornecedor"]) or nome for u, nome in UTIL}
    br = lambda iso: dt.date.fromisoformat(iso).strftime("%d/%m/%y") if iso else ""
    em = "; ".join(f"{c['fornecedor'] or dict(UTIL)[c['utilidade']]} - {br(c['data_emissao'])}" for c in contas if c["data_emissao"])
    ve = "; ".join(f"{c['fornecedor'] or dict(UTIL)[c['utilidade']]} - {br(c['data_vencimento'])}" for c in contas if c["data_vencimento"])
    ws.append(["Data de emissão", "Data de vencimento", forn["energia"], forn["agua"], forn["gas"]])
    ws.append([em, ve, d["totais"]["contas"]["energia"], d["totais"]["contas"]["agua"], d["totais"]["contas"]["gas"]])
    ws.append(["Centro de custo", "Projeto", "Quantidade Energia", "Quantidade Água", "Quantidade Gás", "Observação"])
    ini = 4
    for l in d["linhas"]:
        ws.append([dcc.get(l["centro_custo"]) or l["centro_custo"], l["descricao"] or dpj.get(l["projeto"]) or l["projeto"],
                   l["cobrado"]["energia"], l["cobrado"]["agua"], l["cobrado"]["gas"],
                   (l["observacao"] + (f" (desconto de {l['desc_pct']:g}%)" if l["desc_pct"] else "")).strip()])
    fim = ws.max_row
    ws.append([dcc.get(cfg["cc_engenharia"]) or "Engenharia", "Engenharia"]
              + [f"={c}2-SUM({c}{ini}:{c}{fim})" if fim >= ini else f"={c}2" for c in "CDE"])
    for c in range(1, 7):
        ws.cell(1, c).font = ws.cell(3, c).font = Font(bold=True)
        ws.cell(3, c).fill = PatternFill("solid", fgColor="EDE3FB")
        ws.cell(ws.max_row, c).font = Font(bold=True)
    for r in range(2, ws.max_row + 1):
        for c in (3, 4, 5):
            ws.cell(r, c).number_format = '#,##0.00'
    ws.cell(2, 1).alignment = ws.cell(2, 2).alignment = Alignment(wrap_text=True, vertical="top")
    for col, w in zip("ABCDEF", (34, 34, 18, 18, 18, 40)):
        ws.column_dimensions[col].width = w


def _suprimentos(wb, d, u, nome, cfg, dcc, dpj):
    """Planilha de importação do Suprimentos (formato da 'Planilha Suprimentos'): cabeçalho do documento + itens."""
    from openpyxl.styles import Font, PatternFill
    ws = wb.create_sheet(f"Suprimentos - {nome}"[:31])
    agente = cfg[f"agente_{u}"]
    k = _codigos_erp(agente)
    contas = [c for c in d["contas"] if c["utilidade"] == u]
    total = d["totais"]["contas"][u]
    doc = " / ".join(c["numero_doc"] for c in contas if c["numero_doc"])
    emis = min((c["data_emissao"] for c in contas if c["data_emissao"]), default="")
    venc = min((c["data_vencimento"] for c in contas if c["data_vencimento"]), default="")
    D = lambda iso: dt.date.fromisoformat(iso) if iso else None
    ws.append(["CAMPO FIXO", "DATA ENTRADA", "DATA EMISSÃO", "DATA VENCIMENTO", "NUMERO DOC", "VALOR TOTAL ", "OBSERVAÇÃO", "ORGANIZAÇÃO",
               "FILIAL", "AÇÃO", "SÉRIE NF", "TIPO DOC", "AGENTE", "COND PAGAMENTO", "TIPO DE PREÇO", "VALOR TOTAL ", "NUMERO DOC", "PARCELA", "VALOR TOTAL "])
    obs = f"{nome} {d['mes'][5:]}/{d['mes'][:4]} - " + " + ".join(c["fornecedor"] for c in contas if c["fornecedor"])
    ws.append(["@", dt.date.today(), D(emis), D(venc), doc, total, obs.strip(" -"), int(cfg["organizacao"]), int(cfg["filial"]), int(cfg["acao"]),
               k["serie"], "RECIBO", int(agente), 0, "CIF", total, doc, 1, total])
    ws.append(["CAMPO FIXO", "Valor unitario", "CENTRO DE CUSTO", "PROJETO", "SEQ ITEM", "CÓD ITEM", "APLICAÇÃO", "TIPO DE CLASSE", "QUANTIDADE",
               "Valor Total", "Valor outros ICMS", "Base Cálculo ICMS", "Valor outros IPI", "CFOP"])
    itens = [(l["centro_custo"], l["projeto"], l["cobrado"][u]) for l in d["linhas"] if l["cobrado"][u]]
    eng = d["totais"]["engenharia"][u]
    if eng:
        itens.append((cfg["cc_engenharia"], cfg["projeto_engenharia"], eng))
    for seq, (cc, pj, v) in enumerate(itens, 1):
        num = lambda x: int(x) if str(x).isdigit() else (x or "")
        ws.append(["!", 1, num(cc), num(pj), seq, k["cod_item"], k["aplicacao"], k["tipo_classe"], round(v, 2), round(v, 2), round(v, 2), 0, round(v, 2), k["cfop"]])
    for c in range(1, 20):
        ws.cell(1, c).font = ws.cell(3, c).font = Font(bold=True)
        ws.cell(1, c).fill = PatternFill("solid", fgColor="EDE3FB")
    for c in range(1, 15):
        ws.cell(3, c).fill = PatternFill("solid", fgColor="EDE3FB")
    for c in (2, 3, 4):
        ws.cell(2, c).number_format = "dd/mm/yyyy"
    for r in range(2, ws.max_row + 1):
        for c in (6, 9, 10, 11, 13, 16, 19):
            ws.cell(r, c).number_format = '#,##0.00'
    soma = round(sum(v for _, _, v in itens), 2)
    if abs(soma - total) > 0.01:
        ws.cell(ws.max_row + 2, 1, f"ATENÇÃO: a soma dos itens (R$ {soma:,.2f}) não fecha com o valor das contas (R$ {total:,.2f}).").font = Font(bold=True, color="B42318")
    for col in range(1, 20):
        ws.column_dimensions[ws.cell(1, col).column_letter].width = 15


# ----------------------------------------------------------------------------- GateX (medição de energia)
GATEX_HOSTS = {"gatex.exemplo.local"}


def _gatex_partes(link):
    from urllib.parse import parse_qs, urlparse
    u = urlparse((link or "").strip())
    sid = (parse_qs(u.query).get("sid") or [""])[0]
    if not u.scheme or not u.netloc or not sid:
        abort(400, "Cole em Configurações o link do GateX (abra o GateX no navegador e copie o endereço, com o '?sid=...').")
    # o servidor abre este endereço: só o GateX, para o link não servir de passagem para outras máquinas da rede
    if u.scheme not in ("http", "https") or (u.hostname or "").lower().split(".")[0] not in GATEX_HOSTS:
        abort(400, f"O link precisa ser do servidor do GateX ({', '.join(sorted(GATEX_HOSTS))}).")
    return f"{u.scheme}://{u.netloc}", sid


def _gatex_html(base, sid, caminho, **params):
    import urllib.error
    import urllib.request
    from urllib.parse import urlencode
    url = f"{base}{caminho}?{urlencode({**params, 'sid': sid})}"
    class SemRedirecionar(urllib.request.HTTPRedirectHandler):   # GateX manda para o login quando a sessão expira
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), SemRedirecionar())   # servidor interno: sem proxy
    expirou = "A sessão do GateX expirou. Abra o GateX no navegador, copie o endereço de novo e cole em Suprimentos › Configurações."
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "CentralEngenharia"}), timeout=15) as r:
            final = r.geturl()
            html = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308, 401, 403):
            abort(409, expirou)
        abort(502, f"O GateX respondeu com erro {e.code}.")
    except urllib.error.URLError as e:
        abort(502, f"Não consegui acessar o GateX ({base}): {getattr(e, 'reason', e)}. O computador do site precisa estar na rede da empresa ou na VPN.")
    except TimeoutError:
        abort(504, "O GateX demorou demais para responder.")
    if "login" in final.lower() or ('type="password"' in html.lower() or "type=password" in html.lower()):
        abort(409, expirou)
    return html


def _txt_html(h):
    import html as H
    return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", h or ""))).strip()


def _num_br(t):
    m = re.search(r"-?[\d.]+(?:,\d+)?", (t or "").replace("R$", ""))
    return importer.num(m.group(0)) if m else 0.0


def gatex_mes(con, mes):
    """Locatários (consumo e valor do mês) e eventos (consumo e custo) do GateX, para lançar na energia."""
    from concurrent.futures import ThreadPoolExecutor
    base, sid = _gatex_partes(config(con)["gatex_link"])
    html = _gatex_html(base, sid, "/", month=mes)
    texto = _txt_html(html)
    resumo_g = {}
    for chave, rot in (("enel_kwh", r"Consumo ENEL em [^ ]+ ([\d.,]+) kWh"), ("locatarios_kwh", r"Consumo Locat[aá]rios ([\d.,]+) kWh"),
                       ("eventos_kwh", r"Consumo Eventos ([\d.,]+) kWh"), ("tarifa", r"Tarifa vigente[^R]*R\$ ([\d.,]+)")):
        m = re.search(rot, texto)
        if m:
            resumo_g[chave] = importer.num(m.group(1))
    locs = {}
    for tid, miolo in re.findall(r'href="/tenant\?id=(\d+)[^"]*"[^>]*>(.*?)</a>', html, re.S):
        nome = _txt_html(miolo).replace("Ver consumo, medidores e faturamento →", "").replace("Ver consumo, medidores e faturamento", "").strip()
        locs.setdefault(tid, nome)
    eventos = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        if "event?id=" not in tr:
            continue
        cel = [_txt_html(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if len(cel) >= 4:
            eid = re.search(r"event\?id=(\d+)", tr).group(1)
            eventos.append({"chave": f"E:{cel[0].upper()}", "gatex_id": eid, "tipo": "evento", "nome": cel[0], "data": importer.data_iso(cel[1]),
                            "kwh": _num_br(cel[2]), "valor": _num_br(cel[3])})

    def um(tid):
        h = _gatex_html(base, sid, "/tenant", id=tid, month=mes)
        t = _txt_html(h)
        mv = re.search(r"TOTAL FATUR[AÁ]VEL ([\d.,]+) kWh R\$ ([\d.,]+)", t) or re.search(r"Valor estimado R\$ ([\d.,]+)", t)
        mk = re.search(r"Consumo em \S+ ([\d.,]+) kWh", t)
        if mv and mv.re.pattern.startswith("TOTAL"):
            return {"kwh": importer.num(mv.group(1)), "valor": importer.num(mv.group(2))}
        return {"kwh": importer.num(mk.group(1)) if mk else 0.0, "valor": importer.num(mv.group(1)) if mv else 0.0}

    with ThreadPoolExecutor(max_workers=6) as ex:
        valores = dict(zip(locs, ex.map(um, locs)))
    locatarios = [{"chave": f"T:{tid}", "gatex_id": tid, "tipo": "locatario", "nome": nome, **valores[tid]} for tid, nome in locs.items()]
    mapa = {r["chave"]: {"descricao": r["descricao"], "ignorar": bool(r["ignorar"])} for r in con.execute("SELECT * FROM sup_gatex_mapa")}
    itens = sorted(locatarios, key=lambda x: x["nome"]) + eventos
    for i in itens:
        i["mapa"] = mapa.get(i["chave"])
    return {"mes": mes, "itens": itens, "resumo": resumo_g, "origem": base}


# ----------------------------------------------------------------------------- rotas
def registrar_rotas(app, guarda, registrar):
    import sup_modelo
    with db.connect() as con:
        con.executescript(SCHEMA)
        con.execute("DELETE FROM sup_conta_rateio WHERE conta_id NOT IN (SELECT id FROM sup_contas)")
        if "eng_valor" not in [r[1] for r in con.execute("PRAGMA table_info(sup_contas)")]:
            con.execute("ALTER TABLE sup_contas ADD COLUMN eng_valor REAL")   # parte da Engenharia digitada (vazio = calculada pelo rateio)
        cols = [r[1] for r in con.execute("PRAGMA table_info(sup_linhas)")]
        for c in ("evento_id INTEGER", "energia_kwh REAL", "agua_m3 REAL", "gas_m3 REAL", "poco REAL", "poco_m3 REAL"):
            if c.split()[0] not in cols:
                con.execute(f"ALTER TABLE sup_linhas ADD COLUMN {c}")
        cm = [r[1] for r in con.execute("PRAGMA table_info(sup_meses)")]
        for c in ("poco_valor REAL", "poco_m3 REAL", "poco_separado INTEGER"):   # poço do mês (total) e se tem coluna própria (vazio = sim)
            if c.split()[0] not in cm:
                con.execute(f"ALTER TABLE sup_meses ADD COLUMN {c}")

    def corpo():
        return request.get_json(silent=True) or {}

    @app.get("/api/sup/base")
    @guarda
    def sup_base():
        ano = request.args.get("ano")
        with db.connect() as con:
            cc = [dict(r) for r in con.execute("SELECT nome, descricao FROM bud_centros ORDER BY CAST(nome AS INTEGER), nome")]
            pj = [dict(r) for r in con.execute("SELECT nome, descricao, centro_custo FROM bud_projetos ORDER BY CAST(nome AS INTEGER), nome")]
            return jsonify(meses=resumo(con, ano), centros=cc, projetos=pj, config=config(con), utilidades=UTIL,
                           agentes=NOMES_AGENTE)

    @app.get("/api/sup/mes/<mes>")
    @guarda
    def sup_mes(mes):
        with db.connect() as con:
            return jsonify(calcular(con, _mes_ok(mes)))

    @app.post("/api/sup/meses")
    @guarda
    def sup_novo_mes():
        """{mes, copiar_de?: 'AAAA-MM'} — cria o mês; copiar_de traz as linhas (CC, projeto, desconto) e,
        se pedido, os valores."""
        d = corpo()
        mes = _mes_ok(d.get("mes"))
        with db.connect() as con:
            if con.execute("SELECT 1 FROM sup_meses WHERE mes=?", (mes,)).fetchone():
                abort(409, f"O mês {mes[5:]}/{mes[:4]} já existe.")
            cfg = config(con)
            con.execute("INSERT INTO sup_meses(mes, poco_separado) VALUES (?,?)", (mes, 0 if cfg.get("poco_separado") == "0" else 1))
            n = 0
            ccs_evento = {cfg[k] for k in CATEGORIA_CC.values()}
            if d.get("copiar_de"):
                origem = _mes_ok(d["copiar_de"])
                com_valores = bool(d.get("com_valores"))
                for l in con.execute("SELECT * FROM sup_linhas WHERE mes=? ORDER BY ordem, id", (origem,)).fetchall():
                    if l["evento_id"] or l["centro_custo"] in ccs_evento:
                        continue   # evento é do mês dele: os do mês novo vêm do Relatório de eventos
                    con.execute("""INSERT INTO sup_linhas(mes, ordem, centro_custo, projeto, descricao, energia, agua, gas, desc_pct,
                                   desc_energia, desc_agua, desc_gas, observacao, energia_kwh, agua_m3, gas_m3) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                                (mes, l["ordem"], l["centro_custo"], l["projeto"], l["descricao"],
                                 l["energia"] if com_valores else 0, l["agua"] if com_valores else 0, l["gas"] if com_valores else 0,
                                 l["desc_pct"], l["desc_energia"], l["desc_agua"], l["desc_gas"], l["observacao"],
                                 *[(l[QCOL[u]] if com_valores else (0 if l[QCOL[u]] is not None else None)) for u in UKEYS]))
                    n += 1
            eventos = inserir_eventos(con, mes) if d.get("eventos", True) else []
        return jsonify(ok=True, mes=mes, copiadas=n, eventos=eventos)

    @app.post("/api/sup/meses/<mes>/eventos")
    @guarda
    def sup_trazer_eventos(mes):
        """Traz do Relatório de eventos só os eventos do mês que ainda não têm linha (não mexe em nada que já existe)."""
        mes = _mes_ok(mes)
        with db.connect() as con:
            novos = inserir_eventos(con, mes)
            faltam = [e for e in eventos_do_mes(con, mes) if not _evento_na_linha(con, e["id"])]
        return jsonify(ok=True, novos=novos, ja_tinham=len(faltam))

    @app.delete("/api/sup/meses/<mes>")
    @guarda
    def sup_excluir_mes(mes):
        mes = _mes_ok(mes)
        with db.connect() as con:
            con.execute("DELETE FROM sup_conta_rateio WHERE conta_id IN (SELECT id FROM sup_contas WHERE mes=?)", (mes,))
            for t in ("sup_linhas", "sup_contas", "sup_meses"):
                con.execute(f"DELETE FROM {t} WHERE mes=?", (mes,))
        return jsonify(ok=True)

    @app.post("/api/sup/contas")
    @guarda
    def sup_salvar_conta():
        d = corpo()
        mes = _mes_ok(d.get("mes"))
        u = d.get("utilidade")
        if u not in UKEYS:
            abort(400, "Escolha a conta: energia, água ou gás.")
        vals = (mes, u, importer.txt(d.get("fornecedor")), importer.txt(d.get("numero_doc")), importer.data_iso(d.get("data_emissao")),
                importer.data_iso(d.get("data_vencimento")), importer.num(d.get("valor")), importer.txt(d.get("observacao")))
        with db.connect() as con:
            con.execute("INSERT OR IGNORE INTO sup_meses(mes) VALUES (?)", (mes,))
            if d.get("id"):
                con.execute("""UPDATE sup_contas SET mes=?, utilidade=?, fornecedor=?, numero_doc=?, data_emissao=?, data_vencimento=?,
                               valor=?, observacao=? WHERE id=?""", (*vals, int(d["id"])))
            else:
                cid = con.execute("""INSERT INTO sup_contas(mes, utilidade, fornecedor, numero_doc, data_emissao, data_vencimento, valor, observacao)
                                     VALUES (?,?,?,?,?,?,?,?)""", vals).lastrowid
                _copiar_budget_conta(con, cid)
        return jsonify(ok=True)

    @app.post("/api/sup/meses/<mes>/poco")
    @guarda
    def sup_poco_mes(mes):
        """{valor, m3}: total do poço artesiano no mês (vazio = usa a soma do que foi medido)."""
        mes = _mes_ok(mes)
        d = corpo()
        v = None if d.get("valor") in (None, "") else importer.num(d.get("valor"))
        q = None if d.get("m3") in (None, "") else importer.num(d.get("m3"))
        with db.connect() as con:
            con.execute("INSERT OR IGNORE INTO sup_meses(mes) VALUES (?)", (mes,))
            con.execute("UPDATE sup_meses SET poco_valor=?, poco_m3=? WHERE mes=?", (v, q, mes))
        return jsonify(ok=True)

    @app.post("/api/sup/meses/<mes>/poco-coluna")
    @guarda
    def sup_poco_coluna(mes):
        """{separado: bool}: poço artesiano com coluna própria no rateio do mês ou somado à água. Não apaga nada:
        os valores do poço das linhas (e os dos eventos, lidos do Relatório) voltam quando a coluna volta."""
        mes = _mes_ok(mes)
        sep = 1 if corpo().get("separado") else 0
        with db.connect() as con:
            con.execute("INSERT OR IGNORE INTO sup_meses(mes) VALUES (?)", (mes,))
            con.execute("UPDATE sup_meses SET poco_separado=? WHERE mes=?", (sep, mes))
        return jsonify(ok=True, separado=bool(sep))

    @app.get("/api/sup/budget-linhas")
    @guarda
    def sup_budget_linhas():
        """Linhas do budget (centro de custo + projeto + classe) do ano, para escolher onde entra cada conta."""
        ano = int(request.args.get("ano") or dt.date.today().year)
        cond_v, par_v = visao.cond_item("i")
        with db.connect() as con:
            rows = con.execute(f"""SELECT i.id, i.centro_custo, i.projeto, i.classe_numero, i.classe_descricao,
                                         COALESCE(bc.descricao,'') AS cc_desc, COALESCE(bp.descricao,'') AS pj_desc, p.valor AS aprovado
                                  FROM bud_previsto p JOIN bud_itens i ON i.id = p.item_id
                                  LEFT JOIN bud_centros bc ON bc.nome = i.centro_custo LEFT JOIN bud_projetos bp ON bp.nome = i.projeto
                                  WHERE p.ano=? AND {cond_v} ORDER BY i.centro_custo, i.projeto, i.classe_numero""", (ano, *par_v)).fetchall()
            return jsonify([dict(r) for r in rows])

    @app.post("/api/sup/contas/<int:cid>/budget")
    @guarda
    def sup_conta_budget(cid):
        """{partes: [{item_id, pct}], eng_valor?} — divide a parte da Engenharia da conta entre linhas do budget (soma até 100%).
        eng_valor: valor da Engenharia digitado (vazio/None = usa o calculado pelo rateio)."""
        b = corpo()
        partes = [p for p in (b.get("partes") or []) if p.get("item_id")]
        tot = 0.0
        for p in partes:
            p["pct"] = importer.num(p.get("pct"))
            if p["pct"] <= 0:
                abort(400, "Cada linha precisa de um % maior que zero.")
            tot += p["pct"]
        if tot > 100.005:
            abort(400, f"A soma dá {tot:.2f}%".replace(".", ",") + ": não pode passar de 100%.")
        with db.connect() as con:
            if not con.execute("SELECT 1 FROM sup_contas WHERE id=?", (cid,)).fetchone():
                abort(404, "Conta não encontrada.")
            if "eng_valor" in b:
                ev = None if b["eng_valor"] in (None, "") else importer.num(b["eng_valor"])
                if ev is not None and ev < 0:
                    abort(400, "O valor da Engenharia não pode ser negativo.")
                con.execute("UPDATE sup_contas SET eng_valor=? WHERE id=?", (ev, cid))
            con.execute("DELETE FROM sup_conta_rateio WHERE conta_id=?", (cid,))
            for p in partes:
                con.execute("INSERT INTO sup_conta_rateio(conta_id, item_id, pct) VALUES (?,?,?)", (cid, int(p["item_id"]), p["pct"]))
        return jsonify(ok=True, pct=round(tot, 4))

    @app.delete("/api/sup/contas/<int:cid>")
    @guarda
    def sup_excluir_conta(cid):
        with db.connect() as con:
            con.execute("DELETE FROM sup_contas WHERE id=?", (cid,))
            con.execute("DELETE FROM sup_conta_rateio WHERE conta_id=?", (cid,))
        return jsonify(ok=True)

    CAMPOS = ("centro_custo", "projeto", "descricao", "energia", "agua", "gas", "desc_pct", "desc_energia", "desc_agua", "desc_gas", "observacao",
              "energia_kwh", "agua_m3", "gas_m3", "poco", "poco_m3")

    def _valor(k, v):
        if k in ("poco", "poco_m3"):    # poço artesiano: vazio = evento usa o do Relatório de eventos
            return None if v in (None, "") else importer.num(v)
        if k in QCOL.values():          # consumo medido: vazio = a linha usa o valor em R$ digitado
            return None if v in (None, "") else importer.num(v)
        if k in ("energia", "agua", "gas", "desc_pct"):
            n = importer.num(v)
            if k == "desc_pct" and not 0 <= n <= 100:
                abort(400, "O desconto precisa estar entre 0 e 100%.")
            return n
        if k.startswith("desc_"):
            return 1 if v in (True, 1, "1", "true", "sim", "S") else 0
        return importer.txt(v)

    @app.post("/api/sup/linhas")
    @guarda
    def sup_salvar_linha():
        """Cria ({mes, ...campos}) ou altera ({id, ...só os campos que mudaram})."""
        d = corpo()
        campos = {k: _valor(k, d[k]) for k in CAMPOS if k in d}
        with db.connect() as con:
            if d.get("id"):
                if campos:
                    con.execute(f"UPDATE sup_linhas SET {', '.join(k + '=?' for k in campos)} WHERE id=?", (*campos.values(), int(d["id"])))
                lid = int(d["id"])
            else:
                mes = _mes_ok(d.get("mes"))
                con.execute("INSERT OR IGNORE INTO sup_meses(mes) VALUES (?)", (mes,))
                ordem = con.execute("SELECT COALESCE(MAX(ordem),0)+1 FROM sup_linhas WHERE mes=?", (mes,)).fetchone()[0]
                campos.setdefault("descricao", "")
                cols = ["mes", "ordem", *campos]
                lid = con.execute(f"INSERT INTO sup_linhas({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                                  (mes, ordem, *campos.values())).lastrowid
        return jsonify(ok=True, id=lid)

    @app.post("/api/sup/linhas/excluir")
    @guarda
    def sup_excluir_linhas():
        ids = [int(x) for x in corpo().get("ids") or []]
        with db.connect() as con:
            for i in ids:
                con.execute("DELETE FROM sup_linhas WHERE id=?", (i,))
        return jsonify(ok=True, n=len(ids))

    @app.post("/api/sup/linhas/desconto")
    @guarda
    def sup_desconto():
        """{ids, pct, energia, agua, gas} — aplica (ou tira, com pct 0) o desconto em várias linhas."""
        d = corpo()
        ids = [int(x) for x in d.get("ids") or []]
        pct = _valor("desc_pct", d.get("pct"))
        flags = [1 if d.get(u) else 0 for u in UKEYS]
        if pct and not any(flags):
            abort(400, "Escolha em quais contas o desconto vale (energia, água e/ou gás).")
        with db.connect() as con:
            for i in ids:
                con.execute("UPDATE sup_linhas SET desc_pct=?, desc_energia=?, desc_agua=?, desc_gas=? WHERE id=?", (pct, *flags, i))
        return jsonify(ok=True, n=len(ids))

    @app.post("/api/sup/config")
    @guarda
    def sup_salvar_config():
        d = corpo()
        with db.connect() as con:
            for k in CONFIG_PADRAO:
                if k in d:
                    con.execute("INSERT INTO sup_config(chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                                (k, importer.txt(d[k])))
        return jsonify(ok=True)

    @app.get("/api/sup/gatex")
    @guarda
    def sup_gatex():
        with db.connect() as con:
            return jsonify(gatex_mes(con, _mes_ok(request.args.get("mes"))))

    @app.post("/api/sup/gatex/lancar")
    @guarda
    def sup_gatex_lancar():
        """{mes, itens: [{chave, nome, valor, destino: <id da linha> | 'nova' | 'ignorar'}]} — soma os valores de energia
        de cada linha (vários itens podem ir para a mesma linha), cria linhas novas e lembra o destino de cada item."""
        d = corpo()
        mes = _mes_ok(d.get("mes"))
        somas, novas, n_ign = {}, [], 0
        with db.connect() as con:
            con.execute("INSERT OR IGNORE INTO sup_meses(mes) VALUES (?)", (mes,))
            linhas = {r["id"]: dict(r) for r in con.execute("SELECT * FROM sup_linhas WHERE mes=?", (mes,))}
            for it in d.get("itens") or []:
                destino, chave, valor = str(it.get("destino") or "ignorar"), importer.txt(it.get("chave")), importer.num(it.get("valor"))
                if destino == "ignorar":
                    n_ign += 1
                    con.execute("INSERT INTO sup_gatex_mapa(chave, descricao, ignorar) VALUES (?, '', 1) "
                                "ON CONFLICT(chave) DO UPDATE SET ignorar=1, descricao=''", (chave,))
                    continue
                if destino == "nova":
                    nome = importer.txt(it.get("nome"))
                    ordem = con.execute("SELECT COALESCE(MAX(ordem),0)+1 FROM sup_linhas WHERE mes=?", (mes,)).fetchone()[0]
                    lid = con.execute("INSERT INTO sup_linhas(mes, ordem, descricao, energia) VALUES (?,?,?,0)", (mes, ordem, nome)).lastrowid
                    linhas[lid] = {"id": lid, "descricao": nome}
                    novas.append(nome)
                    destino = lid
                lid = int(destino)
                if lid not in linhas:
                    continue
                somas[lid] = somas.get(lid, 0) + importer.num(it.get("kwh"))
                con.execute("INSERT INTO sup_gatex_mapa(chave, descricao, ignorar) VALUES (?,?,0) "
                            "ON CONFLICT(chave) DO UPDATE SET descricao=excluded.descricao, ignorar=0", (chave, linhas[lid]["descricao"]))
            for lid, v in somas.items():
                con.execute("UPDATE sup_linhas SET energia_kwh=? WHERE id=?", (round(v, 2), lid))   # valor = kWh × tarifa do mês
        return jsonify(ok=True, linhas=len(somas), novas=novas, ignorados=n_ign)

    @app.get("/api/sup/tarifas")
    @guarda
    def sup_tarifas():
        with db.connect() as con:
            return jsonify([dict(r) for r in con.execute("SELECT * FROM sup_tarifas ORDER BY mes DESC, utilidade")])

    @app.post("/api/sup/tarifas")
    @guarda
    def sup_salvar_tarifa():
        """{mes (da conta), utilidade, fatura, consumo, tarifa?} — base da tarifa: conta ÷ consumo (ou tarifa digitada)."""
        d = corpo()
        mes, u = _mes_ok(d.get("mes")), d.get("utilidade")
        if u not in UKEYS:
            abort(400, "Escolha a conta: energia, água ou gás.")
        nv = lambda k: None if d.get(k) in (None, "") else importer.num(d.get(k))
        with db.connect() as con:
            con.execute("""INSERT INTO sup_tarifas(mes, utilidade, fatura, consumo, tarifa) VALUES (?,?,?,?,?)
                           ON CONFLICT(mes, utilidade) DO UPDATE SET fatura=excluded.fatura, consumo=excluded.consumo, tarifa=excluded.tarifa""",
                        (mes, u, nv("fatura"), nv("consumo"), nv("tarifa")))
        return jsonify(ok=True)

    @app.post("/api/sup/cadastro")
    @guarda
    def sup_cadastro():
        """{tipo: 'cc'|'projeto', nome (nº), descricao} — inclui centro de custo / projeto nas listas (mesmas do Budget)."""
        d = corpo()
        nome = importer.txt(d.get("nome")).split(".")[0]
        if not nome:
            abort(400, "Informe o número.")
        with db.connect() as con:
            if d.get("tipo") == "cc":
                con.execute("INSERT OR IGNORE INTO bud_centros(nome, descricao) VALUES (?,?)", (nome, importer.txt(d.get("descricao"))))
            else:
                con.execute("INSERT OR IGNORE INTO bud_projetos(nome, descricao, centro_custo) VALUES (?,?,?)",
                            (nome, importer.txt(d.get("descricao")), importer.txt(d.get("centro_custo"))))
        return jsonify(ok=True, nome=nome)

    @app.get("/api/sup/exportar")
    @guarda
    def sup_exportar():
        mes = request.args.get("mes")
        ano = request.args.get("ano")
        with db.connect() as con:
            buf = gerar_excel(con, mes=_mes_ok(mes) if mes else None, ano=ano)
        nome = f"SUPRIMENTOS - CONSUMO {mes[5:]}-{mes[:4]}.xlsx" if mes else f"SUPRIMENTOS - CONSUMO {ano or 'TODOS OS MESES'}.xlsx"
        return send_file(buf, as_attachment=True, download_name=nome,
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.get("/api/sup/planilha")
    @guarda
    def sup_planilha():
        """Planilha no formato do modelo do setor (requisitante + Suprimentos). Um mês: .xlsx; vários (de / até): .zip."""
        import sup_modelo
        import zipfile
        agente = request.args.get("agente") if request.args.get("agente") in UKEYS else "energia"
        with db.connect() as con:
            if request.args.get("mes"):
                meses = [_mes_ok(request.args["mes"])]
            else:
                de, ate = request.args.get("de") or "0000-00", request.args.get("ate") or "9999-99"
                meses = [m["mes"] for m in resumo(con) if de <= m["mes"] <= ate][::-1]
            if not meses:
                abort(400, "Nenhum mês no período escolhido.")
            cfg, (dcc, dpj) = config(con), descricoes(con)
            try:
                arquivos = {m: sup_modelo.gerar(calcular(con, m), cfg, dcc, dpj, agente) for m in meses}
            except FileNotFoundError as e:
                abort(400, str(e))
        nome = lambda m: f"PLANILHA DE IMPORTAÇÃO - SUPRIMENTOS {m[5:]}-{m[:4]}.xlsx"
        if len(meses) == 1:
            return send_file(BytesIO(arquivos[meses[0]]), as_attachment=True, download_name=nome(meses[0]),
                             mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for m, b in arquivos.items():
                z.writestr(nome(m), b)
        buf.seek(0)
        return send_file(buf, as_attachment=True, download_name=f"PLANILHAS SUPRIMENTOS {meses[0]} a {meses[-1]}.zip", mimetype="application/zip")

    @app.get("/api/sup/linhas")
    @guarda
    def sup_todas_linhas():
        """Todas as linhas (com o valor cobrado) e a Engenharia de cada mês, com o grupo de cada linha — base dos filtros do resumo."""
        ano = request.args.get("ano")
        with db.connect() as con:
            cfg = config(con)
            saida = []
            for m in resumo(con, ano):
                d = calcular(con, m["mes"])
                for l in d["linhas"]:
                    saida.append({"mes": m["mes"], "descricao": l["descricao"], "centro_custo": l["centro_custo"], "projeto": l["projeto"],
                                  "grupo": grupo_da_linha(l, cfg), "cobrado": {**l["cobrado"], "poco": l["poco"]}, "desconto": l["desconto"],
                                  "evento_id": l.get("evento_id"), "qtd": l["qtd"], "pct": l["pct"], "poco_estimado": l["poco_estimado"]})
                t = d["totais"]
                saida.append({"mes": m["mes"], "descricao": "Parte da Engenharia", "centro_custo": cfg["cc_engenharia"], "projeto": cfg["projeto_engenharia"],
                              "grupo": "engenharia", "cobrado": {**t["engenharia"], "poco": t["poco_engenharia"] or 0}, "desconto": {u: 0 for u in UKEYS},
                              "qtd": {"poco": t["poco_engenharia_m3"]}, "pct": dict(t["engenharia_pct"]), "poco_estimado": False})
        return jsonify(saida)

    @app.get("/api/sup/modelo")
    @guarda
    def sup_modelo():
        with db.connect() as con:
            buf = gerar_excel(con, modelo=True)
        return send_file(buf, as_attachment=True, download_name="MODELO DE IMPORTAÇÃO - SUPRIMENTOS.xlsx",
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.post("/api/sup/importar")
    @guarda
    def sup_importar():
        import tempfile
        from pathlib import Path
        arq = request.files.get("arquivo")
        if not arq:
            abort(400, "Escolha a planilha.")
        mes = request.form.get("mes") or ""
        if mes:
            mes = _mes_ok(mes)
        modo = "acrescentar" if request.form.get("modo") == "acrescentar" else "substituir"
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / ("planilha" + (Path(arq.filename or "").suffix or ".xlsx"))
            arq.save(tmp)
            with db.connect() as con:
                res = importar_planilha(con, tmp, mes, modo)
        return jsonify(res)
