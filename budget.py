"""Budget: anos, classes financeiras (centro de custo + projeto + classe), previsto por ano,
pedidos, realocações de verba e o gasto que vem das medições de NF.

Estrutura
- bud_itens: uma "linha" do budget = centro de custo + projeto + classe financeira (nº e descrição).
  A mesma classe pode aparecer em projetos/centros de custo diferentes (são linhas diferentes).
- bud_previsto: valor previsto de cada linha em cada ano.
- Gasto do ano/mês = medições de NF (não canceladas) + pedidos (não cancelados) ligados à linha,
  pela data (medição: data da medição; pedido: data de emissão).
  NF ligada a um PEDIDO não soma de novo (o valor do pedido já está no gasto).
  Classe da medição: a escolhida na própria medição; senão a do item (linha) do contrato usado na medição;
  senão, se todos os itens do contrato têm a mesma classe (ex.: contrato com um item só), essa classe;
  senão a classe padrão do contrato.
- Cadastros (bud_centros, bud_projetos, bud_classes): listas que alimentam as listas suspensas.
- Lançamento com centro de custo/projeto/classe que não tem linha no budget do ano NÃO entra na conta:
  o site avisa ("fora do budget").
- Realocação de verba: tira valor de uma linha e coloca em outra. O previsto original não muda:
  saldo atual = previsto + realocações recebidas - realocações enviadas; saldo restante = saldo atual - gasto.
Tudo é somado com SQL (GROUP BY), então continua rápido com muitos anos de dados.
"""
import datetime as dt
import re
import uuid
from io import BytesIO
from pathlib import Path

from flask import abort, jsonify, request, send_file
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from werkzeug.utils import secure_filename

import db
import exporter
import importer
import lixeira
import seguranca
import visao

PEDIDOS_DIR = db.DATA_DIR / "pedidos"
MOTIVOS = ["MATERIAL MANUTENÇÃO CIVIL", "MATERIAL ELÉTRICA", "MATERIAL HIDRÁULICA", "AVARIAS",
           "CONTAS", "OBRAS", "SERVIÇO", "CONTRATOS"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS bud_itens (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    centro_custo     TEXT NOT NULL DEFAULT '',
    projeto          TEXT NOT NULL DEFAULT '',
    classe_numero    TEXT NOT NULL DEFAULT '',
    classe_descricao TEXT DEFAULT '',
    UNIQUE(centro_custo, projeto, classe_numero)
);
CREATE TABLE IF NOT EXISTS bud_anos (
    ano        INTEGER PRIMARY KEY,
    observacao TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bud_previsto (
    ano      INTEGER NOT NULL,
    item_id  INTEGER NOT NULL REFERENCES bud_itens(id) ON DELETE CASCADE,
    valor    REAL DEFAULT 0,
    PRIMARY KEY (ano, item_id)
);
CREATE TABLE IF NOT EXISTS bud_pedidos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    numero         TEXT NOT NULL,
    data_emissao   TEXT DEFAULT '',
    valor          REAL DEFAULT 0,
    motivo         TEXT DEFAULT '',
    item_id        INTEGER REFERENCES bud_itens(id),
    fornecedor     TEXT DEFAULT '',
    observacao     TEXT DEFAULT '',
    status         TEXT DEFAULT 'ATIVO',       -- ATIVO | CANCELADO
    anexo_arquivo  TEXT DEFAULT '',
    anexo_nome     TEXT DEFAULT '',
    caminho_externo TEXT DEFAULT '',
    criado_em      TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS bud_realocacoes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    data       TEXT NOT NULL,
    origem_id  INTEGER REFERENCES bud_itens(id),
    destino_id INTEGER REFERENCES bud_itens(id),
    valor      REAL DEFAULT 0,
    motivo     TEXT DEFAULT '',
    criado_em  TEXT DEFAULT (datetime('now','localtime'))
);
-- centro de custo e projeto: "nome" guarda o NÚMERO (código), que é o que fica nas linhas do budget
CREATE TABLE IF NOT EXISTS bud_centros (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT NOT NULL UNIQUE,          -- nº do centro de custo
    descricao   TEXT DEFAULT '',
    observacao  TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bud_projetos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nome          TEXT NOT NULL UNIQUE,        -- nº do projeto
    descricao     TEXT DEFAULT '',
    centro_custo  TEXT DEFAULT '',          -- opcional: filtra a lista de projetos pelo centro de custo
    observacao    TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bud_classes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    numero     TEXT NOT NULL UNIQUE,
    descricao  TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS nf_rateio (          -- rateio de uma NF (medição) entre várias linhas do budget
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    medicao_id  INTEGER NOT NULL,
    item_id     INTEGER NOT NULL REFERENCES bud_itens(id),
    pct         REAL NOT NULL,                  -- % do valor da NF (a parte = valor da NF × pct / 100)
    valor       REAL                            -- valor digitado (quando o rateio foi feito por valor)
);
CREATE TABLE IF NOT EXISTS bud_pedido_rateio (  -- rateio de um pedido de compra entre várias linhas do budget
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id   INTEGER NOT NULL,
    item_id     INTEGER NOT NULL REFERENCES bud_itens(id),
    pct         REAL NOT NULL,
    valor       REAL
);
CREATE INDEX IF NOT EXISTS ix_nf_rateio ON nf_rateio(medicao_id);
CREATE INDEX IF NOT EXISTS ix_bud_ped_rateio ON bud_pedido_rateio(pedido_id);
CREATE INDEX IF NOT EXISTS ix_bud_ped_data ON bud_pedidos(data_emissao);
CREATE INDEX IF NOT EXISTS ix_bud_ped_item ON bud_pedidos(item_id);
CREATE INDEX IF NOT EXISTS ix_bud_real_data ON bud_realocacoes(data);
"""

# gasto vindo das medições de NF: classe da medição > classe do item do contrato > classe padrão do contrato
# contrato cujos itens usam todos a mesma classe (ex.: um item só): a medição sem item escolhido usa essa classe
ITEM_UNICO = """(SELECT contrato_id, MIN(budget_item_id) AS bid FROM nf_contrato_itens GROUP BY contrato_id
    HAVING COUNT(DISTINCT budget_item_id) = 1 AND COUNT(budget_item_id) = COUNT(*))"""
# NF com rateio: aparece uma vez para cada parte (rt), cada parte na sua linha e com o seu valor
ITEM_MED = "COALESCE(rt.item_id, m.budget_item_id, ci.budget_item_id, cu.bid, c.budget_item_id)"
VAL_MED = "(CASE WHEN rt.id IS NULL THEN m.valor ELSE m.valor * rt.pct / 100.0 END)"
DATA_MED = "COALESCE(NULLIF(m.data_medicao,''), m.data_emissao)"
FROM_MED = f""" FROM nf_medicoes m LEFT JOIN nf_contratos c ON c.id = m.contrato_id
    LEFT JOIN nf_contrato_itens ci ON ci.id = m.contrato_item_id AND ci.contrato_id = m.contrato_id
    LEFT JOIN {ITEM_UNICO} cu ON cu.contrato_id = m.contrato_id
    LEFT JOIN nf_rateio rt ON rt.medicao_id = m.id """
# pedidos de compra com rateio: uma linha por parte (item_bud / valor_bud)
PED_ALOC = """(SELECT p.*, COALESCE(pr.item_id, p.item_id) AS item_bud,
    (CASE WHEN pr.id IS NULL THEN p.valor ELSE p.valor * pr.pct / 100.0 END) AS valor_bud, pr.pct AS rateio_pct
    FROM bud_pedidos p LEFT JOIN bud_pedido_rateio pr ON pr.pedido_id = p.id)"""
_SQL_MED = f"""
    SELECT {ITEM_MED} AS item_id, {DATA_MED} AS data, {VAL_MED} AS valor
    {FROM_MED}
    WHERE m.status <> 'CANCELADA' AND m.pedido_id IS NULL AND {ITEM_MED} IS NOT NULL"""


def _pct_txt(p):
    return f"{p:.2f}".rstrip("0").rstrip(".").replace(".", ",") + "%"


def migrar(con):
    novo = not con.execute("SELECT 1 FROM sqlite_master WHERE name='bud_classes'").fetchone()
    con.executescript(SCHEMA)
    # rateio some junto com a NF / o pedido
    con.executescript("""
        CREATE TRIGGER IF NOT EXISTS tg_nf_rateio_del AFTER DELETE ON nf_medicoes BEGIN DELETE FROM nf_rateio WHERE medicao_id = OLD.id; END;
        CREATE TRIGGER IF NOT EXISTS tg_ped_rateio_del AFTER DELETE ON bud_pedidos BEGIN DELETE FROM bud_pedido_rateio WHERE pedido_id = OLD.id; END;
        DELETE FROM nf_rateio WHERE medicao_id NOT IN (SELECT id FROM nf_medicoes);
        DELETE FROM bud_pedido_rateio WHERE pedido_id NOT IN (SELECT id FROM bud_pedidos);""")
    for tabela, col in (("nf_medicoes", "budget_item_id"), ("nf_contratos", "budget_item_id"), ("nf_medicoes", "contrato_item_id")):
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({tabela})")]
        if cols and col not in cols:
            con.execute(f"ALTER TABLE {tabela} ADD COLUMN {col} INTEGER")
    cols = [r[1] for r in con.execute("PRAGMA table_info(bud_pedidos)")]
    for col in ("cnpj", "processo", "cotacao", "projeto_pend", "cc_pend", "descricao"):   # campos lidos do PDF do pedido
        if col not in cols:
            con.execute(f"ALTER TABLE bud_pedidos ADD COLUMN {col} TEXT DEFAULT ''")
    if con.execute("SELECT 1 FROM sqlite_master WHERE name='nf_contrato_itens'").fetchone() and \
            "pedido_id" in [r[1] for r in con.execute("PRAGMA table_info(nf_medicoes)")]:
        reparar_itens_de_outro_contrato(con)
    if "solicitado" not in [r[1] for r in con.execute("PRAGMA table_info(bud_previsto)")]:
        # valor = APROVADO pela controladoria (o que já existia vira aprovado); solicitado = pedido pela gestora
        con.execute("ALTER TABLE bud_previsto ADD COLUMN solicitado REAL")
    for tabela in ("bud_centros", "bud_projetos"):
        if "descricao" not in [r[1] for r in con.execute(f"PRAGMA table_info({tabela})")]:
            con.execute(f"ALTER TABLE {tabela} ADD COLUMN descricao TEXT DEFAULT ''")
    if novo:   # primeira vez: os cadastros começam com o que já existe nas linhas do budget
        for i in con.execute("SELECT * FROM bud_itens").fetchall():
            _cadastrar(con, i["centro_custo"], i["projeto"], i["classe_numero"], i["classe_descricao"])


def _cod(v):
    """Número/código (centro de custo, projeto): 9010.0 do Excel vira '9010'."""
    return _txt(v).upper().strip()


def _cadastrar(con, cc, projeto, classe_num, classe_desc="", cc_desc="", pj_desc=""):
    """Garante que centro de custo, projeto e classe estejam nos cadastros (listas suspensas).
    Descrições só preenchem o que está vazio."""
    if cc:
        con.execute("INSERT OR IGNORE INTO bud_centros(nome, descricao) VALUES (?,?)", (cc, cc_desc or ""))
        if cc_desc:
            con.execute("UPDATE bud_centros SET descricao=? WHERE nome=? AND COALESCE(descricao,'')=''", (cc_desc, cc))
    if projeto:
        con.execute("INSERT OR IGNORE INTO bud_projetos(nome, descricao, centro_custo) VALUES (?,?,?)", (projeto, pj_desc or "", cc or ""))
        if pj_desc:
            con.execute("UPDATE bud_projetos SET descricao=? WHERE nome=? AND COALESCE(descricao,'')=''", (pj_desc, projeto))
    if classe_num:
        con.execute("INSERT OR IGNORE INTO bud_classes(numero, descricao) VALUES (?,?)", (classe_num, classe_desc or ""))
        if classe_desc:
            con.execute("UPDATE bud_classes SET descricao=? WHERE numero=? AND descricao=''", (classe_desc, classe_num))


def _txt(v):
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return importer.txt(v)


def item_id(con, cc, projeto, classe_num, classe_desc="", criar=True, cc_desc="", pj_desc=""):
    """Linha (centro de custo + projeto + classe). Cria se não existir e registra os valores nos cadastros."""
    cc, projeto, classe_num = _cod(cc), _cod(projeto), _txt(classe_num)
    if not classe_num:
        return None
    m = re.match(r"^\s*(\d[\d.]*)\s*[-–—]\s*(.+)$", classe_num)   # "604 - Custos - Manutenção do Gramado" -> 604
    if m:
        classe_num, classe_desc = m.group(1), classe_desc or m.group(2)
    if projeto and not cc:   # puxa o centro de custo cadastrado no projeto
        r = con.execute("SELECT centro_custo FROM bud_projetos WHERE nome=?", (projeto,)).fetchone()
        cc = (r["centro_custo"] if r else "") or ""
    if cc_desc or pj_desc:
        _cadastrar(con, cc, projeto, "", "", importer.up(cc_desc), importer.up(pj_desc))
    classe_desc = importer.up(classe_desc)
    if not classe_desc:
        r = con.execute("SELECT descricao FROM bud_classes WHERE numero=?", (classe_num,)).fetchone()
        classe_desc = r["descricao"] if r else ""
    r = con.execute("SELECT id, classe_descricao FROM bud_itens WHERE centro_custo=? AND projeto=? AND classe_numero=?",
                    (cc, projeto, classe_num)).fetchone()
    if r:
        if classe_desc and not r["classe_descricao"]:
            con.execute("UPDATE bud_itens SET classe_descricao=? WHERE id=?", (classe_desc, r["id"]))
        return r["id"]
    if not criar:
        return None
    _cadastrar(con, cc, projeto, classe_num, classe_desc)
    return con.execute("INSERT INTO bud_itens(centro_custo, projeto, classe_numero, classe_descricao) VALUES (?,?,?,?)",
                       (cc, projeto, classe_num, classe_desc)).lastrowid


def item_usado(con, iid):
    return any(con.execute(q, (iid,) * n).fetchone() for q, n in (
        ("SELECT 1 FROM bud_previsto WHERE item_id=?", 1), ("SELECT 1 FROM bud_pedidos WHERE item_id=?", 1),
        ("SELECT 1 FROM bud_realocacoes WHERE origem_id=? OR destino_id=?", 2),
        ("SELECT 1 FROM nf_medicoes WHERE budget_item_id=?", 1), ("SELECT 1 FROM nf_contratos WHERE budget_item_id=?", 1),
        ("SELECT 1 FROM nf_contrato_itens WHERE budget_item_id=?", 1)))


def cadastros(con):
    uso = lambda campo: {r[0]: r[1] for r in con.execute(f"SELECT {campo}, COUNT(*) FROM bud_itens GROUP BY 1")}
    ucc, upj, ucl = uso("centro_custo"), uso("projeto"), uso("classe_numero")
    return {
        "centros": [{**dict(r), "n_linhas": ucc.get(r["nome"], 0)} for r in con.execute("SELECT * FROM bud_centros ORDER BY nome")],
        "projetos": [{**dict(r), "n_linhas": upj.get(r["nome"], 0)} for r in con.execute("SELECT * FROM bud_projetos ORDER BY nome")],
        "classes": [{**dict(r), "n_linhas": ucl.get(r["numero"], 0)} for r in con.execute("SELECT * FROM bud_classes ORDER BY numero")],
    }


def linhas_por_ano(con):
    """{ano: [item_id, ...]} — quais linhas existem no budget de cada ano (para avisar 'fora do budget')."""
    out = {}
    for r in con.execute("SELECT ano, item_id FROM bud_previsto"):
        out.setdefault(str(r["ano"]), []).append(r["item_id"])
    return out


def itens(con):
    return [dict(r) for r in con.execute("SELECT * FROM bud_itens ORDER BY centro_custo, projeto, classe_numero")]


def anos(con):
    return [r[0] for r in con.execute("""
        SELECT ano FROM bud_anos UNION SELECT ano FROM bud_previsto
        UNION SELECT CAST(substr(data_emissao,1,4) AS INTEGER) FROM bud_pedidos WHERE data_emissao<>''
        ORDER BY 1 DESC""") if r[0]]


def resumo_ano(con, ano):
    """Linhas do ano com previsto, realocações, gasto (medições + pedidos) e gasto por mês."""
    a = str(ano)
    linhas = {}

    def linha(iid):
        if iid not in linhas:
            linhas[iid] = {"item_id": iid, "previsto": 0.0, "solicitado": None, "aprovado": None,
                           "medicoes": 0.0, "pedidos": 0.0, "consumo": 0.0, "meses": {}}
        return linhas[iid]

    def mes(l, m):
        return l["meses"].setdefault(m, {"medicoes": 0.0, "pedidos": 0.0, "realocacao": 0.0, "consumo": 0.0})

    for r in con.execute("SELECT item_id, valor, solicitado FROM bud_previsto WHERE ano=?", (ano,)):
        l = linha(r["item_id"])
        l["aprovado"], l["solicitado"] = r["valor"], r["solicitado"]
        # saldo e % executado são sempre sobre o APROVADO (linha sem aprovado fica sem saldo)
        l["previsto"] = r["valor"] or 0
    for r in con.execute(f"""SELECT item_id, substr(data,1,7) AS mes, SUM(valor) AS v FROM ({_SQL_MED})
                             WHERE substr(data,1,4)=? GROUP BY 1, 2""", (a,)):
        l = linha(r["item_id"]); l["medicoes"] += r["v"] or 0; mes(l, r["mes"])["medicoes"] += r["v"] or 0
    for r in con.execute(f"""SELECT item_bud AS item_id, substr(data_emissao,1,7) AS mes, SUM(valor_bud) AS v FROM {PED_ALOC}
                            WHERE status<>'CANCELADO' AND item_bud IS NOT NULL AND substr(data_emissao,1,4)=? GROUP BY 1, 2""", (a,)):
        l = linha(r["item_id"]); l["pedidos"] += r["v"] or 0; mes(l, r["mes"])["pedidos"] += r["v"] or 0
    # contas de consumo (energia, água, gás): parte da Engenharia dividida entre linhas do budget (Suprimentos).
    # Entram junto com as medições ("medicoes" = NFs de contratos + contas de consumo); "consumo" separa só elas.
    import sup
    for x in sup.lancamentos_budget(con, ano):
        l = linha(x["item_id"]); mm = mes(l, x["mes"])
        l["medicoes"] += x["valor"]; l["consumo"] += x["valor"]; mm["medicoes"] += x["valor"]; mm["consumo"] += x["valor"]
    # realocações de verba não entram mais na conta (decisão da equipe): saldo = previsto - gasto
    info = {i["id"]: i for i in itens(con)}
    no_ano = {r[0] for r in con.execute("SELECT item_id FROM bud_previsto WHERE ano=?", (ano,))}
    saida = []
    for l in linhas.values():
        i = info.get(l["item_id"])
        if not i or l["item_id"] not in no_ano:   # fora do budget do ano: não entra na conta (o site avisa à parte)
            continue
        l.update({k: i[k] for k in ("centro_custo", "projeto", "classe_numero", "classe_descricao")})
        l["gasto"] = round(l["medicoes"] + l["pedidos"], 2)
        l["saldo"] = round(l["aprovado"] - l["gasto"], 2) if l["aprovado"] is not None else None
        l["pct"] = round(100 * l["gasto"] / l["aprovado"], 1) if l["aprovado"] else None
        l["pct_solicitado"] = round(100 * l["gasto"] / l["solicitado"], 1) if l["solicitado"] else None
        l["corte"] = round(l["aprovado"] - l["solicitado"], 2) if l["aprovado"] is not None and l["solicitado"] is not None else None
        l["meses"] = [{"mes": k, **v, "gasto": round(v["medicoes"] + v["pedidos"], 2)} for k, v in sorted(l["meses"].items())]
        saida.append(l)
    saida.sort(key=lambda l: (l["centro_custo"], l["projeto"], l["classe_numero"]))
    return saida


def gravar_valores(con, ano, iid, solicitado=None, aprovado=None):
    """Grava solicitado e/ou aprovado de uma linha no ano. None/"" = não mexe naquele campo;
    "-" (traço) apaga o valor. Cria a linha no budget se ainda não existir."""
    vals = {}
    for campo, v in (("solicitado", solicitado), ("valor", aprovado)):
        if v is None or (isinstance(v, str) and not v.strip()):
            continue
        vals[campo] = None if str(v).strip() == "-" else importer.num(v)
    if not vals:
        return False
    con.execute("INSERT OR IGNORE INTO bud_anos(ano) VALUES (?)", (ano,))
    if not con.execute("SELECT 1 FROM bud_previsto WHERE ano=? AND item_id=?", (ano, iid)).fetchone():
        con.execute("INSERT INTO bud_previsto(ano, item_id, valor, solicitado) VALUES (?,?,NULL,NULL)", (ano, iid))
    con.execute(f"UPDATE bud_previsto SET {', '.join(k + '=?' for k in vals)} WHERE ano=? AND item_id=?", (*vals.values(), ano, iid))
    return True


def linhas_para_previsto(con, ano):
    """Tudo o que pode ter previsto no ano: linhas do budget + combinações com gasto no ano + as dos itens de contrato
    e da classe padrão dos contratos. Devolve previsto (None = ainda não está no budget) e o gasto do ano."""
    a = str(ano)
    gasto = {}
    for r in con.execute(f"SELECT item_id, SUM(valor) FROM ({_SQL_MED}) WHERE substr(data,1,4)=? GROUP BY 1", (a,)):
        gasto[r[0]] = gasto.get(r[0], 0) + (r[1] or 0)
    for r in con.execute(f"""SELECT item_bud, SUM(valor_bud) FROM {PED_ALOC} WHERE status<>'CANCELADO' AND item_bud IS NOT NULL
                            AND substr(data_emissao,1,4)=? GROUP BY 1""", (a,)):
        gasto[r[0]] = gasto.get(r[0], 0) + (r[1] or 0)
    previsto = {r[0]: (r[1], r[2]) for r in con.execute("SELECT item_id, valor, solicitado FROM bud_previsto WHERE ano=?", (ano,))}
    ids = set(previsto) | set(gasto) | {r[0] for r in con.execute(
        "SELECT budget_item_id FROM nf_contrato_itens WHERE budget_item_id IS NOT NULL "
        "UNION SELECT budget_item_id FROM nf_contratos WHERE budget_item_id IS NOT NULL")}
    info = {i["id"]: i for i in itens(con)}
    saida = [{**info[i], "item_id": i, "no_budget": i in previsto, "aprovado": previsto.get(i, (None, None))[0],
              "solicitado": previsto.get(i, (None, None))[1], "gasto": round(gasto.get(i, 0), 2)} for i in ids if i in info]
    visiveis = visao.ids_itens(con)
    if visiveis is not None:
        saida = [x for x in saida if x["item_id"] in visiveis]
    saida.sort(key=lambda x: (x["projeto"], x["centro_custo"], x["classe_numero"]))
    return saida


def detalhe(con, iid, mes_):
    """Lançamentos de uma linha num mês: medições, pedidos e realocações."""
    out = []
    for r in con.execute(f"""
        SELECT m.id, {DATA_MED} AS data, {VAL_MED} AS valor, rt.pct AS rateio_pct, m.numero_medicao, m.numero_documento,
               c.fornecedor, c.numero AS contrato, ci.numero AS item_numero, ci.descricao AS item_descricao
        {FROM_MED}
        WHERE m.status<>'CANCELADA' AND m.pedido_id IS NULL AND {ITEM_MED}=? AND substr({DATA_MED},1,7)=?""", (iid, mes_)):
        item = f" · item {r['item_numero'] or r['item_descricao']}" if (r["item_numero"] or r["item_descricao"]) else ""
        rat = f" · rateio {_pct_txt(r['rateio_pct'])}" if r["rateio_pct"] is not None else ""
        out.append({"tipo": "MEDIÇÃO", "data": r["data"], "valor": r["valor"], "id": r["id"],
                    "descricao": f"Medição {r['numero_medicao']} · NF {r['numero_documento']} · {r['fornecedor'] or ''} (contrato {r['contrato'] or '—'}{item}){rat}"})
    for r in con.execute(f"""SELECT * FROM {PED_ALOC} WHERE status<>'CANCELADO' AND item_bud=? AND substr(data_emissao,1,7)=?""", (iid, mes_)):
        rat = f" · rateio {_pct_txt(r['rateio_pct'])}" if r["rateio_pct"] is not None else ""
        out.append({"tipo": "PEDIDO", "data": r["data_emissao"], "valor": r["valor_bud"], "id": r["id"],
                    "descricao": f"Pedido {r['numero']} · {r['motivo'] or 'sem motivo'}" + (f" · {r['fornecedor']}" if r["fornecedor"] else "") + rat,
                    "tem_anexo": bool(r["anexo_arquivo"] or r["caminho_externo"])})
    import sup
    for x in sup.lancamentos_budget(con, item=iid, mes=mes_):
        out.append({"tipo": "CONSUMO", "data": x["data"], "valor": x["valor"], "id": x["id"],
                    "descricao": f"{x['ref']} · parte da Engenharia · {_pct_txt(x['pct'])}"})
    return sorted(out, key=lambda x: x["data"])


def sincronizar_medicoes_contrato(con, cid):
    """Depois de editar o contrato: se ele tem UMA linha só, todas as medições dele passam a usar essa linha;
    se não tem linha mas tem classe padrão, todas usam a classe padrão. Contrato com várias linhas: só tira
    das medições item que não é deste contrato (cada medição continua com o item escolhido). Devolve quantas mudaram."""
    linhas = [r[0] for r in con.execute("SELECT id FROM nf_contrato_itens WHERE contrato_id=?", (cid,))]
    padrao = con.execute("SELECT budget_item_id FROM nf_contratos WHERE id=?", (cid,)).fetchone()
    if len(linhas) == 1:
        return con.execute("""UPDATE nf_medicoes SET contrato_item_id=?, budget_item_id=NULL
                              WHERE contrato_id=? AND (contrato_item_id IS NOT ? OR budget_item_id IS NOT NULL)
                                AND id NOT IN (SELECT medicao_id FROM nf_rateio)""",
                           (linhas[0], cid, linhas[0])).rowcount
    if not linhas and padrao and padrao[0]:
        return con.execute("""UPDATE nf_medicoes SET contrato_item_id=NULL, budget_item_id=NULL
                              WHERE contrato_id=? AND (contrato_item_id IS NOT NULL OR budget_item_id IS NOT NULL)
                                AND id NOT IN (SELECT medicao_id FROM nf_rateio)""", (cid,)).rowcount
    return con.execute("""UPDATE nf_medicoes SET contrato_item_id=NULL WHERE contrato_id=? AND contrato_item_id IS NOT NULL
                          AND contrato_item_id NOT IN (SELECT id FROM nf_contrato_itens WHERE contrato_id=?)""", (cid, cid)).rowcount


def reparar_itens_de_outro_contrato(con):
    """Conserta medições cujo item (linha) é de OUTRO contrato (aconteceu ao importar uma planilha em que a medição
    estava em outro contrato): a medição passa para o contrato do item, que é o que a planilha informou."""
    return con.execute("""UPDATE nf_medicoes SET contrato_id = (SELECT i.contrato_id FROM nf_contrato_itens i WHERE i.id = nf_medicoes.contrato_item_id)
                          WHERE contrato_item_id IS NOT NULL AND pedido_id IS NULL
                            AND EXISTS (SELECT 1 FROM nf_contrato_itens i WHERE i.id = nf_medicoes.contrato_item_id
                                        AND i.contrato_id IS NOT nf_medicoes.contrato_id)""").rowcount


def lancamentos_ano(con, ano):
    """Todos os lançamentos do ano que entram no budget (medições + pedidos), um por linha:
    tipo, data, valor, item_id, fornecedor, motivo (pedido) e referência. Base das análises da tela do Budget."""
    a, out = str(ano), []
    no_budget = {r[0] for r in con.execute("SELECT item_id FROM bud_previsto WHERE ano=?", (ano,))}
    for r in con.execute(f"""
        SELECT m.id, {DATA_MED} AS data, {VAL_MED} AS valor, {ITEM_MED} AS item_id, m.numero_medicao, m.numero_documento,
               c.fornecedor, c.numero AS contrato
        {FROM_MED}
        WHERE m.status<>'CANCELADA' AND m.pedido_id IS NULL AND {ITEM_MED} IS NOT NULL AND substr({DATA_MED},1,4)=?""", (a,)):
        if r["item_id"] in no_budget:
            out.append({"tipo": "MEDIÇÃO", "id": r["id"], "data": r["data"], "valor": r["valor"] or 0, "item_id": r["item_id"],
                        "fornecedor": (r["fornecedor"] or "").strip().upper(), "motivo": "",
                        "ref": f"Medição {r['numero_medicao'] or '—'} · NF {r['numero_documento'] or '—'} · contrato {r['contrato'] or '—'}"})
    for r in con.execute(f"""SELECT id, data_emissao, valor_bud AS valor, item_bud AS item_id, numero, motivo, fornecedor FROM {PED_ALOC}
                            WHERE status<>'CANCELADO' AND item_bud IS NOT NULL AND substr(data_emissao,1,4)=?""", (a,)):
        if r["item_id"] in no_budget:
            out.append({"tipo": "PEDIDO", "id": r["id"], "data": r["data_emissao"], "valor": r["valor"] or 0, "item_id": r["item_id"],
                        "fornecedor": (r["fornecedor"] or "").strip().upper(), "motivo": r["motivo"] or "",
                        "ref": f"Pedido {r['numero'] or '—'}"})
    import sup
    for x in sup.lancamentos_budget(con, ano):
        if x["item_id"] in no_budget:
            out.append({"tipo": "CONSUMO", "id": x["id"], "data": x["data"], "valor": x["valor"], "item_id": x["item_id"],
                        "fornecedor": x["fornecedor"], "motivo": "", "ref": x["ref"] + f" · {_pct_txt(x['pct'])} da parte da Engenharia"})
    visiveis = visao.ids_itens(con)
    if visiveis is not None:
        out = [x for x in out if x["item_id"] in visiveis]
    return sorted(out, key=lambda x: x["data"] or "")


def fora_budget(con, ano=None):
    """Medições e pedidos com centro de custo/projeto/classe que NÃO têm linha no budget do ano da data:
    esses valores não estão sendo calculados. Também conta o que está sem classe nenhuma."""
    sem_linha = "NOT EXISTS (SELECT 1 FROM bud_previsto bp WHERE bp.item_id = x.item_id AND bp.ano = CAST(substr(x.data,1,4) AS INTEGER))"
    filtro_ano, par = ("AND substr(x.data,1,4)=?", (str(ano),)) if ano else ("", ())
    med = con.execute(f"""SELECT * FROM (
            SELECT m.id, {DATA_MED} AS data, {VAL_MED} AS valor, {ITEM_MED} AS item_id, m.numero_medicao, m.numero_documento,
                   c.fornecedor, c.numero AS contrato, ci.numero AS item_numero
            {FROM_MED} WHERE m.status<>'CANCELADA' AND m.pedido_id IS NULL AND {ITEM_MED} IS NOT NULL) x
        WHERE x.data<>'' {filtro_ano} AND {sem_linha} ORDER BY x.data DESC""", par).fetchall()
    ped = con.execute(f"""SELECT * FROM (
            SELECT p.id, p.data_emissao AS data, p.valor_bud AS valor, p.item_bud AS item_id, p.numero, p.motivo, p.fornecedor
            FROM {PED_ALOC} p WHERE p.status<>'CANCELADO' AND p.item_bud IS NOT NULL) x
        WHERE x.data<>'' {filtro_ano} AND {sem_linha} ORDER BY x.data DESC""", par).fetchall()
    info = {i["id"]: i for i in itens(con)}
    com_budget = {r[0] for r in con.execute("SELECT DISTINCT ano FROM bud_previsto")}
    lista = []
    for tipo, rows in (("MEDIÇÃO", med), ("PEDIDO", ped)):
        for r in rows:
            i = info.get(r["item_id"], {})
            a = int(r["data"][:4])
            desc = (f"Medição {r['numero_medicao']} · NF {r['numero_documento']} · {r['fornecedor'] or ''} (contrato {r['contrato'] or '—'}"
                    + (f" · item {r['item_numero']}" if r["item_numero"] else "") + ")") if tipo == "MEDIÇÃO" else \
                   f"Pedido {r['numero']} · {r['motivo'] or 'sem motivo'}" + (f" · {r['fornecedor']}" if r["fornecedor"] else "")
            lista.append({"tipo": tipo, "id": r["id"], "item_id": r["item_id"], "data": r["data"], "valor": r["valor"], "descricao": desc,
                          "centro_custo": i.get("centro_custo", ""), "projeto": i.get("projeto", ""),
                          "classe_numero": i.get("classe_numero", ""), "classe_descricao": i.get("classe_descricao", ""),
                          "motivo": f"não há budget cadastrado para {a}" if a not in com_budget else f"essa linha não está no budget de {a}"})
    visiveis = visao.ids_itens(con)
    if visiveis is not None:
        lista = [x for x in lista if x["item_id"] in visiveis]
    lista.sort(key=lambda x: x["data"], reverse=True)
    f_ano, p_ano = ("AND substr(d,1,4)=?", (str(ano),)) if ano else ("", ())
    sem = {
        "medicoes": dict(con.execute(f"""SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS valor FROM (
            SELECT {DATA_MED} AS d, m.valor {FROM_MED} WHERE m.status<>'CANCELADA' AND m.pedido_id IS NULL AND {ITEM_MED} IS NULL) WHERE 1=1 {f_ano}""", p_ano).fetchone()),
        "pedidos": dict(con.execute(f"""SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS valor FROM (
            SELECT data_emissao AS d, valor FROM bud_pedidos WHERE status<>'CANCELADO' AND item_id IS NULL) WHERE 1=1 {f_ano}""", p_ano).fetchone()),
    }
    if visiveis is not None:   # o que não tem classe não aparece para quem tem visão restrita
        sem = {k: {"n": 0, "valor": 0} for k in sem}
    return {"itens": lista[:1000], "n": len(lista), "valor": round(sum(x["valor"] or 0 for x in lista), 2),
            "medicoes": [x["id"] for x in lista if x["tipo"] == "MEDIÇÃO"], "pedidos": [x["id"] for x in lista if x["tipo"] == "PEDIDO"], "sem_classe": sem}


# ----------------------------------------------------------------------------- Excel (modelo, exportar, importar)
COLS = {
    "BUDGET": ["ANO", "CENTRO DE CUSTO (Nº)", "CENTRO DE CUSTO (DESCRIÇÃO)", "PROJETO (Nº)", "PROJETO (DESCRIÇÃO)",
               "CLASSE FINANCEIRA (Nº)", "CLASSE FINANCEIRA (DESCRIÇÃO)", "SOLICITADO (R$)", "APROVADO (R$)"],
    "PEDIDOS": ["Nº PEDIDO", "DATA EMISSÃO", "VALOR TOTAL (R$)", "MOTIVO", "CENTRO DE CUSTO (Nº)", "PROJETO (Nº)",
                "CLASSE FINANCEIRA (Nº)", "FORNECEDOR", "OBSERVAÇÃO", "STATUS", "CAMINHO DO ANEXO"],
    "REALOCACOES": ["DATA", "VALOR (R$)", "ORIGEM - CENTRO DE CUSTO (Nº)", "ORIGEM - PROJETO (Nº)", "ORIGEM - CLASSE (Nº)",
                    "DESTINO - CENTRO DE CUSTO (Nº)", "DESTINO - PROJETO (Nº)", "DESTINO - CLASSE (Nº)", "MOTIVO"],
    "CENTROS DE CUSTO": ["CENTRO DE CUSTO (Nº)", "CENTRO DE CUSTO (DESCRIÇÃO)", "OBSERVAÇÃO"],
    "PROJETOS": ["PROJETO (Nº)", "PROJETO (DESCRIÇÃO)", "CENTRO DE CUSTO (Nº)", "OBSERVAÇÃO"],
    "CLASSES FINANCEIRAS": ["CLASSE FINANCEIRA (Nº)", "CLASSE FINANCEIRA (DESCRIÇÃO)"],
}
FORMATOS = {
    "BUDGET": [exporter.INT, None, None, None, None, None, None, exporter.BRL, exporter.BRL],
    "PEDIDOS": [None, exporter.DATA, exporter.BRL, None, None, None, None, None, None, None, None],
    "REALOCACOES": [exporter.DATA, exporter.BRL, None, None, None, None, None, None, None],
    "CENTROS DE CUSTO": [None, None, None], "PROJETOS": [None, None, None, None], "CLASSES FINANCEIRAS": [None, None],
}
LARGURAS = {
    "BUDGET": [8, 16, 30, 14, 32, 16, 36, 16, 16],
    "PEDIDOS": [14, 14, 16, 28, 20, 26, 18, 30, 36, 12, 50],
    "REALOCACOES": [12, 14, 20, 24, 16, 20, 24, 16, 40],
    "CENTROS DE CUSTO": [20, 40, 50], "PROJETOS": [16, 40, 20, 40], "CLASSES FINANCEIRAS": [22, 50],
}
TITULOS = {"BUDGET": ("Budget", "Previsto por ano e classe financeira"),
           "PEDIDOS": ("Pedidos", "Pedidos de compra / serviço ligados ao budget"),
           "REALOCACOES": ("Realocações de verba", "Valor que sai de uma classe e vai para outra"),
           "CENTROS DE CUSTO": ("Centros de custo", "Lista suspensa de centros de custo"),
           "PROJETOS": ("Projetos", "Lista suspensa de projetos (centro de custo é opcional)"),
           "CLASSES FINANCEIRAS": ("Classes financeiras", "Lista suspensa de classes (nº e descrição)")}
# o Excel exportado do budget traz também as contas (não são lidas na importação)
COLS_CONTAS = ["DIFERENÇA APROVADO − SOLICITADO (R$)", "INCORRIDO (R$)", "SALDO DO APROVADO (R$)", "% DO APROVADO", "% DO SOLICITADO"]
TABELAS = {"BUDGET": "tbBudget", "PEDIDOS": "tbPedidos", "REALOCACOES": "tbRealocacoes",
           "CENTROS DE CUSTO": "tbCentrosCusto", "PROJETOS": "tbProjetos", "CLASSES FINANCEIRAS": "tbClasses"}
CADASTROS = ("CENTROS DE CUSTO", "PROJETOS", "CLASSES FINANCEIRAS")
TIPOS_EXCEL = {"budget": ("BUDGET",), "pedidos": ("PEDIDOS",), "realocacoes": ("REALOCACOES",), "cadastros": CADASTROS}
TODAS = ("BUDGET", "PEDIDOS", "REALOCACOES") + CADASTROS
NOMES_MODELO = {"budget": "BUDGET", "pedidos": "PEDIDOS", "realocacoes": "REALOCAÇÕES", "cadastros": "CADASTROS (CENTROS DE CUSTO, PROJETOS E CLASSES)"}

LEIA = {
    "BUDGET": [("BUDGET", True),
               ("Uma linha por ano + centro de custo + projeto + classe financeira. A mesma classe pode repetir em projetos diferentes.", False),
               ("Centro de custo e projeto: o Nº identifica (é o que liga tudo); a DESCRIÇÃO é opcional e completa o cadastro.", False),
               ("SOLICITADO = valor pedido pela gestora; APROVADO = valor aprovado pela controladoria. Célula em branco não mexe no site.", False),
               ("Centro de custo, projeto ou classe que ainda não estão nos Cadastros são cadastrados automaticamente.", False)],
    "PEDIDOS": [("PEDIDOS", True),
                ("MOTIVO deve ser um destes: " + ", ".join(MOTIVOS) + ".", False),
                ("Centro de custo + projeto + classe ligam o pedido à linha do budget (o ano vem da data de emissão).", False),
                ("Se essa combinação não estiver no budget do ano, o pedido entra mas o valor não é calculado (o site avisa).", False),
                ("Pedido que já existe (mesmo nº) não é duplicado: só os campos vazios no site são completados.", False),
                ("STATUS: ATIVO ou CANCELADO (vazio = ATIVO). CAMINHO DO ANEXO é opcional (ex.: C:\\...\\pedido.pdf).", False)],
    "REALOCACOES": [("REALOCACOES", True),
                    ("Valor que sai da ORIGEM e entra no DESTINO. O previsto original não muda: muda o saldo atual das duas linhas no ano da DATA.", False),
                    ("Realocação igual (mesma data, origem, destino e valor) não é duplicada.", False)],
    "CENTROS DE CUSTO": [("CENTROS DE CUSTO, PROJETOS e CLASSES FINANCEIRAS (cadastros)", True),
                         ("São as listas suspensas usadas no budget, nos pedidos, nos contratos e nas medições.", False),
                         ("Itens que já existem não são duplicados (só completa campos vazios, ex.: descrição da classe).", False),
                         ("Centro de custo e projeto têm Nº + descrição; classe financeira tem Nº + descrição.", False),
                         ("Em PROJETOS, o CENTRO DE CUSTO (Nº) é opcional: quando preenchido, o projeto aparece só para aquele centro de custo.", False)],
}


def _planilha(wb, aba, linhas):
    ws = wb.create_sheet(aba)
    exporter._faixa(ws, max(len(COLS[aba]), 3), *TITULOS[aba])
    exporter._tabela(ws, TABELAS[aba], COLS[aba], linhas or [[None] * len(COLS[aba])], FORMATOS[aba], LARGURAS[aba])
    return ws


def gerar_excel(con, quais=TODAS, ano=None, modelo=False, filtro=None):
    wb = Workbook()
    wb.remove(wb.active)
    if modelo:
        ws = wb.create_sheet("LEIA-ME")
        nomes = ", ".join(TITULOS[q][0] for q in quais)
        exporter._faixa(ws, 6, f"Modelo de importação · {nomes}", "Central de Engenharia · Engenharia & Infraestrutura")
        textos = [("Como preencher", True),
                  ("Preencha a partir da linha 5 de cada aba (a linha 4 é o cabeçalho). Não mude os nomes das abas nem das colunas.", False),
                  ("As linhas que já vêm preenchidas são EXEMPLOS: apague antes de importar. Pode enviar só as abas que precisar.", False),
                  ("Importe pelo botão “Importar planilha” da página (Budget, Pedidos, Realocações ou Cadastros).", False), ("", False)]
        for q in quais:
            if q in LEIA:
                textos += LEIA[q] + [("", False)]
        for i, (t, b) in enumerate(textos, 5):
            ws.cell(i, 1, t).font = Font(name=exporter.FONTE, size=12 if b else 10, bold=b, color=exporter.ROXO if b else "1E002F")
        ws.column_dimensions["A"].width = 130
        ws.sheet_properties.tabColor = exporter.VERDE_900
        hoje, a = dt.date.today(), dt.date.today().year
        ex = {
            "BUDGET": [[a, "9010", "MANUTENÇÃO", "1001", "MANUTENÇÃO PREDIAL", "4.1.01", "MATERIAL DE MANUTENÇÃO", 150000, 120000],
                       [a, "9010", "MANUTENÇÃO", "1002", "EVENTOS", "4.1.01", "MATERIAL DE MANUTENÇÃO", 45000, 45000],
                       [a, "9010", "MANUTENÇÃO", "1002", "EVENTOS", "4.2.10", "ENERGIA ELÉTRICA", 110000, None]],
            "PEDIDOS": [["4500012345", hoje, 1250.9, "MATERIAL ELÉTRICA", "9010", "1001", "4.1.01",
                         "FORNECEDOR EXEMPLO LTDA", "Lâmpadas e reatores", "ATIVO", ""],
                        ["4500012346", hoje, 3800, "SERVIÇO", "9010", "1002", "4.1.02",
                         "PRESTADORA EXEMPLO S.A.", "", "ATIVO", "C:\\Pedidos\\4500012346.pdf"]],
            "REALOCACOES": [[hoje, 5000, "9010", "1001", "4.1.01", "9010", "1002", "4.1.01",
                             "Reforço para temporada de shows"]],
            "CENTROS DE CUSTO": [["9010", "MANUTENÇÃO", "Engenharia & Infraestrutura"], ["9020", "OPERAÇÕES", ""]],
            "PROJETOS": [["1001", "MANUTENÇÃO PREDIAL", "9010", ""], ["1002", "EVENTOS", "9010", "Jogos e shows"], ["1003", "ARENA 2026", "", ""]],
            "CLASSES FINANCEIRAS": [["4.1.01", "MATERIAL DE MANUTENÇÃO"], ["4.1.02", "SERVIÇOS DE MANUTENÇÃO"], ["4.2.10", "ENERGIA ELÉTRICA"]],
        }
        for aba in quais:
            ws = _planilha(wb, aba, ex[aba])
            if aba == "PEDIDOS":
                dv = DataValidation(type="list", formula1='"' + ",".join(MOTIVOS) + '"', allow_blank=True)
                ws.add_data_validation(dv); dv.add("D5:D2000")
                dv2 = DataValidation(type="list", formula1='"ATIVO,CANCELADO"', allow_blank=True)
                ws.add_data_validation(dv2); dv2.add("J5:J2000")
        buf = BytesIO(); wb.save(buf); buf.seek(0)
        return buf

    info = {i["id"]: i for i in itens(con)}
    visiveis = visao.ids_itens(con)
    chave = lambda iid: [info[iid]["centro_custo"], info[iid]["projeto"], info[iid]["classe_numero"]] if iid in info else ["", "", ""]
    if "BUDGET" in quais:
        q = "SELECT p.ano, p.item_id, p.valor FROM bud_previsto p"
        args = ()
        if ano:
            q += " WHERE p.ano=?"; args = (ano,)
        linhas = []
        dcc = {c["nome"]: c["descricao"] or "" for c in con.execute("SELECT nome, descricao FROM bud_centros")}
        dpj = {c["nome"]: c["descricao"] or "" for c in con.execute("SELECT nome, descricao FROM bud_projetos")}
        contas = {}
        q = q.replace("p.valor FROM", "p.valor, p.solicitado FROM")
        for r in con.execute(q + " ORDER BY p.ano DESC, p.item_id", args):
            i = info.get(r["item_id"])
            if not i or (visiveis is not None and r["item_id"] not in visiveis):
                continue
            if r["ano"] not in contas:
                contas[r["ano"]] = {l["item_id"]: l for l in resumo_ano(con, r["ano"])}
            l = contas[r["ano"]].get(r["item_id"], {})
            linhas.append([r["ano"], i["centro_custo"], dcc.get(i["centro_custo"], ""), i["projeto"], dpj.get(i["projeto"], ""),
                           i["classe_numero"], i["classe_descricao"], r["solicitado"], r["valor"], l.get("corte"),
                           l.get("gasto", 0), l.get("saldo"), (l["pct"] / 100) if l.get("pct") is not None else None,
                           (l["pct_solicitado"] / 100) if l.get("pct_solicitado") is not None else None])
        ws = wb.create_sheet("BUDGET")
        cab = COLS["BUDGET"] + COLS_CONTAS
        exporter._faixa(ws, len(cab), *TITULOS["BUDGET"])
        exporter._tabela(ws, TABELAS["BUDGET"], cab, linhas or [[None] * len(cab)], FORMATOS["BUDGET"] + [exporter.BRL] * 3 + ["0.0%", "0.0%"],
                         LARGURAS["BUDGET"] + [16] * len(COLS_CONTAS))
    if "PEDIDOS" in quais:
        cond_v, par_v = visao.cond_pedido()
        q = f"SELECT p.* FROM bud_pedidos p LEFT JOIN bud_itens i ON i.id = p.item_id WHERE {cond_v}"
        args = list(par_v)
        f = filtro or {}
        if ano and not (f.get("de") or f.get("ate")):
            q += " AND substr(p.data_emissao,1,4)=?"; args.append(str(ano))
        for campo, sql in (("de", "p.data_emissao>=?"), ("ate", "p.data_emissao<=?"), ("cc", "i.centro_custo=?"), ("projeto", "i.projeto=?")):
            if f.get(campo):
                q += " AND " + sql; args.append(f[campo])
        # colunas da importação + descrições da classe / centro de custo / projeto (a importação ignora as extras)
        dcc = {c["nome"]: c["descricao"] or "" for c in con.execute("SELECT nome, descricao FROM bud_centros")}
        dpj = {c["nome"]: c["descricao"] or "" for c in con.execute("SELECT nome, descricao FROM bud_projetos")}
        rat = {}
        for r in con.execute("""SELECT r.pedido_id, r.pct, i.centro_custo, i.projeto, i.classe_numero, i.classe_descricao
                                FROM bud_pedido_rateio r JOIN bud_itens i ON i.id = r.item_id ORDER BY r.id"""):
            rat.setdefault(r["pedido_id"], []).append(r)
        linhas = []
        for r in con.execute(q + " ORDER BY p.data_emissao DESC", args):
            cc, pj, cl = chave(r["item_id"])
            desc = info[r["item_id"]]["classe_descricao"] if r["item_id"] in info else ""
            partes = rat.get(r["id"]) or []
            rateio = " | ".join(f"{x['classe_numero']} {x['classe_descricao'] or ''} · CC {x['centro_custo']} · PJ {x['projeto']} · "
                                f"{x['pct']:.2f}%".replace(".", ",") for x in partes)
            linhas.append([r["numero"], exporter._d(r["data_emissao"]), r["valor"], r["motivo"], cc, pj, cl, r["fornecedor"],
                           r["observacao"], r["status"], r["caminho_externo"] or (r["anexo_nome"] and f"(anexado no site) {r['anexo_nome']}") or "",
                           desc or None, dcc.get(cc, "") or None, dpj.get(pj, "") or None, rateio or None])
        ws = wb.create_sheet("PEDIDOS")
        cab = COLS["PEDIDOS"] + ["CLASSE FINANCEIRA (DESCRIÇÃO)", "CENTRO DE CUSTO (DESCRIÇÃO)", "PROJETO (DESCRIÇÃO)", "RATEIO (CLASSES)"]
        exporter._faixa(ws, len(cab), *TITULOS["PEDIDOS"])
        exporter._tabela(ws, TABELAS["PEDIDOS"], cab, linhas or [[None] * len(cab)], FORMATOS["PEDIDOS"] + [None] * 4,
                         LARGURAS["PEDIDOS"] + [36, 28, 28, 60])
    if "REALOCACOES" in quais:
        q = "SELECT * FROM bud_realocacoes"
        args = ()
        if ano:
            q += " WHERE substr(data,1,4)=?"; args = (str(ano),)
        linhas = [[exporter._d(r["data"]), r["valor"], *chave(r["origem_id"]), *chave(r["destino_id"]), r["motivo"]]
                  for r in con.execute(q + " ORDER BY data DESC", args)
                  if visiveis is None or r["origem_id"] in visiveis or r["destino_id"] in visiveis]
        _planilha(wb, "REALOCACOES", linhas)
    cad = cadastros(con) if set(quais) & set(CADASTROS) else None
    if "CENTROS DE CUSTO" in quais:
        _planilha(wb, "CENTROS DE CUSTO", [[c["nome"], c["descricao"], c["observacao"]] for c in cad["centros"]])
    if "PROJETOS" in quais:
        _planilha(wb, "PROJETOS", [[p["nome"], p["descricao"], p["centro_custo"], p["observacao"]] for p in cad["projetos"]])
    if "CLASSES FINANCEIRAS" in quais:
        _planilha(wb, "CLASSES FINANCEIRAS", [[c["numero"], c["descricao"]] for c in cad["classes"]])
    buf = BytesIO(); wb.save(buf); buf.seek(0)
    return buf


def importar_excel(con, caminho):
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(caminho))
    abas = {importer.sem_acento(n).upper().strip(): n for n in wb.sheet_names}
    res = {"budget_novos": 0, "budget_atualizados": 0, "pedidos": 0, "pedidos_completados": 0, "realocacoes": 0,
           "cadastros": 0, "ja_existiam": 0, "ignoradas": 0, "avisos": [], "abas": []}
    n_cad = lambda: sum(con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("bud_centros", "bud_projetos", "bud_classes"))
    cad_antes = n_cad()

    def tabela(nome):
        n = abas.get(importer.sem_acento(nome))
        if not n:
            return []
        res["abas"].append(nome)
        esperados = {importer.sem_acento(importer.up(c)) for c in COLS[nome]}
        d = wb.get_sheet_by_name(n).to_python()
        for i, r in enumerate(d[:10]):
            cab = [importer.sem_acento(importer.up(x)) for x in r]
            if len(esperados & set(cab)) >= min(2, len(esperados)):          # achou a linha do cabeçalho
                # "NÃO ESTÁ NAS LISTAS" (fórmula da planilha de importação) conta como vazio
                return [(i + k + 2, dict(zip(cab, ["" if isinstance(y, str) and y.startswith(importer.AVISOS_LISTA) else y for y in x])))
                        for k, x in enumerate(d[i + 1:]) if any(importer.txt(y) for y in x)]
        return []

    def col(r, *nomes):
        for n in nomes:
            for k, v in r.items():
                if k.startswith(n):
                    return v
        return None

    def cod(r, base):
        """Nº do centro de custo / projeto: coluna "BASE (Nº)" ou, em planilhas antigas, "BASE"."""
        v = col(r, base + " (N")
        return _cod(v if v is not None else r.get(base))

    # cadastros primeiro (as outras abas usam)
    for linha, r in tabela("CENTROS DE CUSTO"):
        nome = cod(r, "CENTRO DE CUSTO")
        if not nome:
            continue
        desc, obs = importer.up(col(r, "CENTRO DE CUSTO (DESC")), importer.txt(col(r, "OBSERVACAO"))
        atual = con.execute("SELECT * FROM bud_centros WHERE nome=?", (nome,)).fetchone()
        if not atual:
            con.execute("INSERT INTO bud_centros(nome, descricao, observacao) VALUES (?,?,?)", (nome, desc, obs))
        else:
            mud = {k: v for k, v in (("descricao", desc), ("observacao", obs)) if v and not atual[k]}
            if mud:
                con.execute(f"UPDATE bud_centros SET {', '.join(k + '=?' for k in mud)} WHERE id=?", (*mud.values(), atual["id"]))
            res["ja_existiam"] += 1
    for linha, r in tabela("PROJETOS"):
        nome = cod(r, "PROJETO")
        if not nome:
            continue
        desc, cc, obs = importer.up(col(r, "PROJETO (DESC")), cod(r, "CENTRO DE CUSTO"), importer.txt(col(r, "OBSERVACAO"))
        if cc:
            con.execute("INSERT OR IGNORE INTO bud_centros(nome) VALUES (?)", (cc,))
        atual = con.execute("SELECT * FROM bud_projetos WHERE nome=?", (nome,)).fetchone()
        if not atual:
            con.execute("INSERT INTO bud_projetos(nome, descricao, centro_custo, observacao) VALUES (?,?,?,?)", (nome, desc, cc, obs))
        else:
            mud = {k: v for k, v in (("descricao", desc), ("centro_custo", cc), ("observacao", obs)) if v and not atual[k]}
            if mud:
                con.execute(f"UPDATE bud_projetos SET {', '.join(k + '=?' for k in mud)} WHERE id=?", (*mud.values(), atual["id"]))
            res["ja_existiam"] += 1
    for linha, r in tabela("CLASSES FINANCEIRAS"):
        num = _txt(col(r, "CLASSE FINANCEIRA (N"))
        if not num:
            continue
        desc = importer.up(col(r, "CLASSE FINANCEIRA (DESC"))
        atual = con.execute("SELECT * FROM bud_classes WHERE numero=?", (num,)).fetchone()
        if not atual:
            con.execute("INSERT INTO bud_classes(numero, descricao) VALUES (?,?)", (num, desc))
        else:
            if desc and not atual["descricao"]:
                con.execute("UPDATE bud_classes SET descricao=? WHERE id=?", (desc, atual["id"]))
            res["ja_existiam"] += 1
        if desc:
            con.execute("UPDATE bud_itens SET classe_descricao=? WHERE classe_numero=? AND classe_descricao=''", (desc, num))

    vistos = {}
    for linha, r in tabela("BUDGET"):
        try:
            ano = int(float(col(r, "ANO") or 0))
        except ValueError:
            ano = 0
        num = _txt(col(r, "CLASSE FINANCEIRA (N"))
        if not ano or not num:
            res["ignoradas"] += 1; res["avisos"].append(f"BUDGET linha {linha}: falta ano ou nº da classe."); continue
        sol = col(r, "SOLICITADO")
        apr = col(r, "APROVADO")
        if apr is None or not importer.txt(apr):
            apr = col(r, "PREVISTO")          # planilhas antigas: PREVISTO = aprovado
        if not importer.txt(sol) and not importer.txt(apr):   # sem valores: a linha não mexe no budget
            res["ignoradas"] += 1
            continue
        iid = item_id(con, cod(r, "CENTRO DE CUSTO"), cod(r, "PROJETO"), num, col(r, "CLASSE FINANCEIRA (DESC"),
                      cc_desc=col(r, "CENTRO DE CUSTO (DESC") or "", pj_desc=col(r, "PROJETO (DESC") or "")
        if (ano, iid) in vistos:
            res["avisos"].append(f"BUDGET linha {linha}: repete a linha {vistos[(ano, iid)]} (mesmo ano, centro de custo, projeto e classe) — valeu o valor da última.")
        vistos[(ano, iid)] = linha
        antes = con.execute("SELECT valor, solicitado FROM bud_previsto WHERE ano=? AND item_id=?", (ano, iid)).fetchone()
        gravar_valores(con, ano, iid, sol if importer.txt(sol) else None, apr if importer.txt(apr) else None)
        depois = con.execute("SELECT valor, solicitado FROM bud_previsto WHERE ano=? AND item_id=?", (ano, iid)).fetchone()
        if not antes:
            res["budget_novos"] += 1
        elif tuple(antes) != tuple(depois):
            res["budget_atualizados"] += 1
        else:
            res["ja_existiam"] += 1

    no_budget = {(r[0], r[1]) for r in con.execute("SELECT ano, item_id FROM bud_previsto")}
    existentes = {r["numero"]: dict(r) for r in con.execute("SELECT * FROM bud_pedidos")}
    for linha, r in tabela("PEDIDOS"):
        num = _txt(next((v for k, v in r.items() if "PEDIDO" in k), None))
        if not num:
            res["ignoradas"] += 1; res["avisos"].append(f"PEDIDOS linha {linha}: sem nº do pedido."); continue
        motivo = importer.up(col(r, "MOTIVO"))
        mot_ok = next((m for m in MOTIVOS if importer.sem_acento(m) == importer.sem_acento(motivo)), motivo)
        classe = _txt(col(r, "CLASSE FINANCEIRA"))
        cc_l, pj_l = cod(r, "CENTRO DE CUSTO"), cod(r, "PROJETO")
        if num in existentes:   # projeto/centro de custo lidos do PDF e guardados esperando a classe
            pj_l = pj_l or existentes[num].get("projeto_pend") or ""
            cc_l = cc_l or existentes[num].get("cc_pend") or ""
        iid = item_id(con, cc_l, pj_l, classe) if classe else None
        st = importer.up(col(r, "STATUS"))
        dados = {"data_emissao": importer.data_iso(col(r, "DATA EMISSAO")) or "", "valor": importer.num(col(r, "VALOR")),
                 "motivo": mot_ok, "item_id": iid, "fornecedor": importer.up(col(r, "FORNECEDOR")),
                 "observacao": importer.txt(col(r, "OBSERVACAO")), "caminho_externo": importer.txt(col(r, "CAMINHO")),
                 "descricao": importer.txt(col(r, "DESCRICAO DO PEDIDO", "DESCRICAO")),
                 "status": "CANCELADO" if st.startswith("CANCEL") else "ATIVO"}
        if dados["caminho_externo"].startswith("(anexado no site)"):
            dados["caminho_externo"] = ""
        if num in existentes:
            atual = existentes[num]
            mud = {k: v for k, v in dados.items() if v and not atual.get(k) and k != "status"}
            if mud:
                con.execute(f"UPDATE bud_pedidos SET {', '.join(k + '=?' for k in mud)} WHERE id=?", (*mud.values(), atual["id"]))
                res["pedidos_completados"] += 1
            else:
                res["ja_existiam"] += 1
            continue
        if not dados["data_emissao"]:
            res["avisos"].append(f"PEDIDOS linha {linha}: pedido {num} sem data de emissão (não entra nos meses do budget).")
        if not iid:
            res["avisos"].append(f"PEDIDOS linha {linha}: pedido {num} sem classe financeira (não entra no budget).")
        elif dados["data_emissao"] and (int(dados["data_emissao"][:4]), iid) not in no_budget:
            res["avisos"].append(f"PEDIDOS linha {linha}: pedido {num} — {cod(r, 'CENTRO DE CUSTO') or 'sem centro de custo'} · "
                                 f"{cod(r, 'PROJETO') or 'sem projeto'} · {classe} não está no budget de {dados['data_emissao'][:4]} "
                                 "(o valor não está sendo calculado).")
        con.execute(f"INSERT INTO bud_pedidos(numero, {', '.join(dados)}) VALUES (?{', ?' * len(dados)})", (num, *dados.values()))
        existentes[num] = {"numero": num, **dados}
        res["pedidos"] += 1

    for linha, r in tabela("REALOCACOES"):
        data = importer.data_iso(col(r, "DATA")) or ""
        valor = importer.num(col(r, "VALOR"))
        o = item_id(con, _cod(col(r, "ORIGEM - CENTRO")), _cod(col(r, "ORIGEM - PROJETO")), col(r, "ORIGEM - CLASSE"))
        d = item_id(con, _cod(col(r, "DESTINO - CENTRO")), _cod(col(r, "DESTINO - PROJETO")), col(r, "DESTINO - CLASSE"))
        if not data or not valor or not (o or d):
            res["ignoradas"] += 1; res["avisos"].append(f"REALOCACOES linha {linha}: falta data, valor ou classe de origem/destino."); continue
        if con.execute("SELECT 1 FROM bud_realocacoes WHERE data=? AND origem_id IS ? AND destino_id IS ? AND ABS(valor-?)<0.005",
                       (data, o, d, valor)).fetchone():
            res["ja_existiam"] += 1; continue
        con.execute("INSERT INTO bud_realocacoes(data, origem_id, destino_id, valor, motivo) VALUES (?,?,?,?,?)",
                    (data, o, d, valor, importer.txt(col(r, "MOTIVO"))))
        res["realocacoes"] += 1
    if not res["abas"]:
        raise ValueError("A planilha não tem as abas BUDGET, PEDIDOS, REALOCACOES ou de cadastros (use a planilha de importação de exemplo).")
    res["cadastros"] = n_cad() - cad_antes
    return res


# ----------------------------------------------------------------------------- pedido lido do PDF
def salvar_pedido_lido(con, d, arquivo=None):
    """Grava o pedido conferido na tela (d = campos lidos do PDF, já editados).
    Pedido novo: entra. Pedido que já existe (mesmo nº): só completa o que está vazio (nada é apagado).
    arquivo = (nome, bytes) do PDF: vira o anexo do pedido se ele ainda não tiver anexo."""
    numero = _txt(d.get("numero"))
    if not numero:
        raise ValueError("Falta o nº do pedido.")
    pj, pj_desc = _cod(d.get("projeto")), importer.up(d.get("projeto_descricao"))
    cc = _cod(d.get("centro_custo"))
    if pj:
        _cadastrar(con, "", pj, "", "", "", pj_desc)
        if not cc:   # centro de custo cadastrado no projeto
            r = con.execute("SELECT centro_custo FROM bud_projetos WHERE nome=?", (pj,)).fetchone()
            cc = (r["centro_custo"] if r else "") or ""
    classe = _txt(d.get("classe_numero"))
    iid = item_id(con, cc, pj, classe) if classe else None
    campos = {"data_emissao": importer.data_iso(d.get("data_emissao")) or "", "valor": importer.num(d.get("valor")),
              "motivo": importer.up(d.get("motivo")), "fornecedor": importer.up(d.get("fornecedor")), "cnpj": importer.txt(d.get("cnpj")),
              "processo": _txt(d.get("processo")), "cotacao": importer.txt(d.get("cotacao")), "descricao": importer.txt(d.get("descricao")),
              "observacao": importer.txt(d.get("observacao")), "item_id": iid,
              "projeto_pend": "" if iid else pj, "cc_pend": "" if iid else cc}
    atual = con.execute("SELECT * FROM bud_pedidos WHERE numero=?", (numero,)).fetchone()
    if atual:
        pid, novo = atual["id"], False
        mud = {k: v for k, v in campos.items() if v and not atual[k]}
        if mud:
            con.execute(f"UPDATE bud_pedidos SET {', '.join(k + '=?' for k in mud)} WHERE id=?", (*mud.values(), pid))
    else:
        novo = True
        pid = con.execute(f"INSERT INTO bud_pedidos(numero, {', '.join(campos)}) VALUES (?{', ?' * len(campos)})",
                          (numero, *campos.values())).lastrowid
    if arquivo and arquivo[1]:
        r = con.execute("SELECT anexo_arquivo, caminho_externo FROM bud_pedidos WHERE id=?", (pid,)).fetchone()
        if not r["anexo_arquivo"]:
            nome = arquivo[0] or f"pedido_{numero}.pdf"
            destino = f"{pid}_{uuid.uuid4().hex[:8]}_{secure_filename(nome) or 'pedido.pdf'}"
            PEDIDOS_DIR.mkdir(parents=True, exist_ok=True)
            (PEDIDOS_DIR / destino).write_bytes(arquivo[1])
            con.execute("UPDATE bud_pedidos SET anexo_arquivo=?, anexo_nome=? WHERE id=?", (destino, nome, pid))
    return pid, novo


def ler_pdfs(con, arquivos):
    """[(nome, bytes)] -> lista com os campos lidos de cada PDF + se o pedido já existe no site."""
    import leitor_pdf
    saida = []
    for nome, dados in arquivos:
        d = leitor_pdf.ler_pedido(dados)
        d["arquivo"] = nome
        if not d.get("erro"):
            ex = con.execute("SELECT p.*, i.centro_custo, i.projeto, i.classe_numero FROM bud_pedidos p "
                             "LEFT JOIN bud_itens i ON i.id=p.item_id WHERE p.numero=?", (d.get("numero"),)).fetchone() if d.get("numero") else None
            d["existe"] = dict(ex) if ex else None
            pj = con.execute("SELECT * FROM bud_projetos WHERE nome=?", (d.get("projeto_numero"),)).fetchone() if d.get("projeto_numero") else None
            d["projeto_cadastrado"] = bool(pj)
            d["centro_custo_projeto"] = pj["centro_custo"] if pj else ""
        saida.append(d)
    return saida


# ----------------------------------------------------------------------------- rotas
def registrar_rotas(app, guarda, registrar, guarda_pedidos=None):
    """guarda: acesso ao Budget. guarda_pedidos: acesso aos Pedidos (ficam em Notas fiscais: quem tem Notas fiscais OU Budget)."""
    guarda_pedidos = guarda_pedidos or guarda
    with db.connect() as con:
        migrar(con)
    PEDIDOS_DIR.mkdir(parents=True, exist_ok=True)

    def corpo():
        return request.get_json(silent=True) or {}

    @app.get("/api/budget/base")
    @guarda_pedidos
    def bud_base():
        with db.connect() as con:
            its, visiveis = itens(con), visao.ids_itens(con)
            cad = cadastros(con)
            no_budget = linhas_por_ano(con)
            if visiveis is not None:
                its = [i for i in its if i["id"] in visiveis]
                no_budget = {a: [i for i in v if i in visiveis] for a, v in no_budget.items()}
            return jsonify(anos=anos(con), itens=its, motivos=MOTIVOS, cadastros=cad, no_budget=no_budget,
                           centros=sorted({i["centro_custo"] for i in its} | {c["nome"] for c in cad["centros"]}),
                           projetos=sorted({i["projeto"] for i in its} | {p["nome"] for p in cad["projetos"]}))

    @app.get("/api/budget/ano/<int:ano>")
    @guarda
    def bud_ano(ano):
        with db.connect() as con:
            visiveis = visao.ids_itens(con)
            return jsonify(ano=ano, linhas=[l for l in resumo_ano(con, ano) if visiveis is None or l["item_id"] in visiveis])

    @app.get("/api/budget/lancamentos")
    @guarda
    def bud_lancamentos():
        with db.connect() as con:
            return jsonify(lancamentos_ano(con, int(request.args.get("ano") or dt.date.today().year)))

    @app.get("/api/budget/detalhe")
    @guarda
    def bud_detalhe():
        with db.connect() as con:
            visao.exigir_item(con, int(request.args["item"]))
            return jsonify(detalhe(con, int(request.args["item"]), request.args["mes"][:7]))

    @app.post("/api/budget/anos")
    @guarda
    def bud_novo_ano():
        d = corpo()
        try:
            ano = int(d.get("ano"))
        except (TypeError, ValueError):
            abort(400, "Informe o ano.")
        with db.connect() as con:
            con.execute("INSERT OR IGNORE INTO bud_anos(ano) VALUES (?)", (ano,))
            if d.get("copiar_de"):   # copia as linhas (e o previsto) de outro ano
                con.execute("INSERT OR IGNORE INTO bud_previsto(ano, item_id, valor, solicitado) SELECT ?, item_id, "
                            + ("valor, solicitado" if d.get("copiar_valores") else "NULL, NULL") + " FROM bud_previsto WHERE ano=?", (ano, int(d["copiar_de"])))
        return jsonify(ok=True)

    @app.delete("/api/budget/anos/<int:ano>")
    @guarda
    def bud_excluir_ano(ano):
        """Apaga o previsto do ano (todas as linhas). Medições, pedidos e cadastros não são tocados."""
        if visao.atual() is not None:   # apagaria linhas que a pessoa não vê
            return jsonify(erro="Sua visão é restrita: só quem vê tudo pode excluir um ano inteiro."), 403
        with db.connect() as con:
            n = con.execute("DELETE FROM bud_previsto WHERE ano=?", (ano,)).rowcount
            con.execute("DELETE FROM bud_anos WHERE ano=?", (ano,))
        return jsonify(ok=True, n=n)

    @app.post("/api/budget/linhas")
    @guarda
    def bud_salvar_linha():
        """Cria/edita uma linha (centro de custo + projeto + classe) e o previsto no ano."""
        d = corpo()
        try:
            ano = int(d.get("ano"))
        except (TypeError, ValueError):
            abort(400, "Informe o ano.")
        if not _txt(d.get("classe_numero")):
            abort(400, "Informe o número da classe financeira.")
        if not visao.permite(_cod(d.get("centro_custo")), _cod(d.get("projeto"))):
            return jsonify(erro="Esse centro de custo e projeto estão fora da sua visão. Peça ao administrador para liberar."), 403
        with db.connect() as con:
            if d.get("item_id"):
                iid = int(d["item_id"])
                visao.exigir_item(con, iid)
                outro = con.execute("SELECT id FROM bud_itens WHERE centro_custo=? AND projeto=? AND classe_numero=?",
                                    (_cod(d.get("centro_custo")), _cod(d.get("projeto")), _txt(d.get("classe_numero")))).fetchone()
                if outro and outro["id"] != iid:
                    return jsonify(erro="Já existe uma linha com esse centro de custo, projeto e classe."), 409
                _cadastrar(con, _cod(d.get("centro_custo")), _cod(d.get("projeto")), _txt(d.get("classe_numero")),
                           importer.up(d.get("classe_descricao")))
                con.execute("UPDATE bud_itens SET centro_custo=?, projeto=?, classe_numero=?, classe_descricao=? WHERE id=?",
                            (_cod(d.get("centro_custo")), _cod(d.get("projeto")), _txt(d.get("classe_numero")),
                             importer.up(d.get("classe_descricao")), iid))
            else:
                iid = item_id(con, d.get("centro_custo"), d.get("projeto"), d.get("classe_numero"), d.get("classe_descricao"))
            if not gravar_valores(con, ano, iid, d.get("solicitado"), d.get("aprovado", d.get("previsto"))):
                con.execute("INSERT OR IGNORE INTO bud_anos(ano) VALUES (?)", (ano,))
                con.execute("INSERT OR IGNORE INTO bud_previsto(ano, item_id, valor) VALUES (?,?,NULL)", (ano, iid))
        return jsonify(ok=True, item_id=iid)

    @app.get("/api/budget/previstos")
    @guarda
    def bud_previstos():
        with db.connect() as con:
            return jsonify(linhas_para_previsto(con, int(request.args.get("ano") or dt.date.today().year)))

    @app.post("/api/budget/previstos")
    @guarda
    def bud_salvar_previstos():
        """{ano, valores: [{item_id, previsto} ou {centro_custo, projeto, classe_numero, previsto}]} — grava o previsto de
        cada linha (cada classe de cada projeto/centro de custo tem o seu valor). Valor vazio = não mexe."""
        d = corpo()
        try:
            ano = int(d.get("ano"))
        except (TypeError, ValueError):
            abort(400, "Informe o ano.")
        n = 0
        with db.connect() as con:
            con.execute("INSERT OR IGNORE INTO bud_anos(ano) VALUES (?)", (ano,))
            for v in d.get("valores") or []:
                if "previsto" in v and "aprovado" not in v:
                    v["aprovado"] = v["previsto"]
                iid = int(v["item_id"]) if v.get("item_id") else item_id(con, v.get("centro_custo"), v.get("projeto"), v.get("classe_numero"))
                if iid:
                    visao.exigir_item(con, iid)
                if iid and gravar_valores(con, ano, iid, v.get("solicitado"), v.get("aprovado")):
                    n += 1
        return jsonify(ok=True, n=n)

    @app.post("/api/budget/linhas/lote")
    @guarda
    def bud_linhas_lote():
        """{ano, item_ids:[...]} — põe no budget do ano as linhas que estão com gasto mas fora do budget (sem valores)."""
        d = corpo()
        try:
            ano = int(d.get("ano"))
        except (TypeError, ValueError):
            abort(400, "Informe o ano.")
        ids = [int(i) for i in d.get("item_ids") or [] if str(i).isdigit()]
        with db.connect() as con:
            for i in ids:
                visao.exigir_item(con, i)
            con.execute("INSERT OR IGNORE INTO bud_anos(ano) VALUES (?)", (ano,))
            n = sum(con.execute("INSERT OR IGNORE INTO bud_previsto(ano, item_id, valor) VALUES (?,?,NULL)", (ano, i)).rowcount for i in ids)
        return jsonify(ok=True, n=n)

    @app.delete("/api/budget/linhas/<int:ano>/<int:iid>")
    @guarda
    def bud_excluir_linha(ano, iid):
        with db.connect() as con:
            visao.exigir_item(con, iid)
            con.execute("DELETE FROM bud_previsto WHERE ano=? AND item_id=?", (ano, iid))
            if not item_usado(con, iid):
                con.execute("DELETE FROM bud_itens WHERE id=?", (iid,))
        return jsonify(ok=True)

    # ---- pedidos
    @app.get("/api/budget/pedidos")
    @guarda_pedidos
    def bud_pedidos():
        a = request.args
        onde, par = ["1=1"], []
        if a.get("ano"):
            onde.append("substr(p.data_emissao,1,4)=?"); par.append(a["ano"])
        if a.get("de"):
            onde.append("p.data_emissao>=?"); par.append(a["de"])
        if a.get("ate"):
            onde.append("p.data_emissao<=?"); par.append(a["ate"])
        rat = lambda campo: (f"(i.{campo}=? OR EXISTS (SELECT 1 FROM bud_pedido_rateio r JOIN bud_itens ri ON ri.id=r.item_id "
                             f"WHERE r.pedido_id=p.id AND ri.{campo}=?))")
        if a.get("cc"):
            onde.append(rat("centro_custo")); par += [a["cc"]] * 2
        if a.get("projeto"):
            onde.append(rat("projeto")); par += [a["projeto"]] * 2
        if a.get("motivo"):
            onde.append("p.motivo=?"); par.append(a["motivo"])
        if a.get("status"):
            onde.append("p.status=?"); par.append(a["status"])
        if a.get("q"):
            for w in importer.sem_acento(a["q"]).lower().split():
                onde.append("lower(p.numero || ' ' || p.fornecedor || ' ' || p.observacao || ' ' || COALESCE(p.descricao,'') || ' ' || COALESCE(p.cnpj,'') || ' ' || COALESCE(p.processo,'') || ' ' || COALESCE(p.projeto_pend,'') || ' ' || COALESCE(i.projeto,'') || ' ' || "
                            "COALESCE(i.classe_numero,'') || ' ' || COALESCE(i.classe_descricao,'') || ' ' || COALESCE(i.centro_custo,'')) LIKE ?")
                par.append(f"%{w}%")
        cond_v, par_v = visao.cond_pedido()
        onde.append(cond_v); par += par_v
        where = " WHERE " + " AND ".join(onde)
        base = " FROM bud_pedidos p LEFT JOIN bud_itens i ON i.id=p.item_id"
        cond_ia, par_ia = visao.cond_item("ia")
        with db.connect() as con:
            fora_sql = ("(p.item_id IS NOT NULL AND p.data_emissao<>'' AND p.status<>'CANCELADO' AND NOT EXISTS (SELECT 1 FROM bud_previsto bp "
                        "WHERE bp.item_id=p.item_id AND bp.ano=CAST(substr(p.data_emissao,1,4) AS INTEGER)))")
            lista = [dict(r) for r in con.execute(
                "SELECT p.*, i.centro_custo, i.projeto, i.classe_numero, i.classe_descricao, "
                f"(p.anexo_arquivo<>'' OR p.caminho_externo<>'') AS tem_anexo, {fora_sql} AS fora_budget, "
                "(SELECT group_concat(ri.classe_numero || ' · CC ' || ri.centro_custo || ' · ' || printf('%.2f', r.pct) || '%', ' | ') "
                "FROM bud_pedido_rateio r JOIN bud_itens ri ON ri.id=r.item_id WHERE r.pedido_id=p.id) AS rateio, "
                "(SELECT COALESCE(SUM(valor),0) FROM nf_medicoes nm WHERE nm.pedido_id=p.id AND nm.status<>'CANCELADA') AS medido, "
                "(SELECT COUNT(*) FROM nf_medicoes nm WHERE nm.pedido_id=p.id AND nm.status<>'CANCELADA') AS n_nfs" + base + where +
                " ORDER BY p.data_emissao DESC, p.id DESC LIMIT 3000", par)]
            por_motivo = [dict(r) for r in con.execute(
                "SELECT p.motivo, COUNT(*) AS n, SUM(p.valor) AS valor" + base + where + " AND p.status<>'CANCELADO' GROUP BY 1 ORDER BY 3 DESC", par)]
            por_mes = [dict(r) for r in con.execute(
                "SELECT substr(p.data_emissao,1,7) AS mes, COUNT(*) AS n, SUM(p.valor) AS valor" + base + where +
                " AND p.status<>'CANCELADO' AND p.data_emissao<>'' GROUP BY 1 ORDER BY 1", par)]
            por_projeto = [dict(r) for r in con.execute(
                # pedido rateado: cada parte no projeto dela
                f"SELECT COALESCE(ia.projeto,'SEM CLASSE') AS projeto, SUM(pa.valor_bud) AS valor FROM {PED_ALOC} pa "
                "LEFT JOIN bud_itens ia ON ia.id = pa.item_bud WHERE pa.status<>'CANCELADO' AND pa.id IN (SELECT p.id" + base + where + ") "
                f"AND {cond_ia} GROUP BY 1 ORDER BY 2 DESC LIMIT 15", par + par_ia)]
            total = con.execute("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN p.status<>'CANCELADO' THEN p.valor END),0) AS valor, "
                                "SUM(p.status='CANCELADO') AS cancelados, SUM(p.item_id IS NULL) AS sem_classe, "
                                f"SUM({fora_sql}) AS fora, COALESCE(SUM(CASE WHEN {fora_sql} THEN p.valor END),0) AS valor_fora" + base + where, par).fetchone()
        return jsonify(pedidos=lista, por_motivo=por_motivo, por_mes=por_mes, por_projeto=por_projeto, total=dict(total))

    @app.post("/api/budget/pedidos")
    @guarda_pedidos
    def bud_salvar_pedido():
        f = request.form
        pid = int(f.get("id") or 0) or None
        numero = _txt(f.get("numero"))
        if not numero:
            abort(400, "Informe o número do pedido.")
        if pid:
            with db.connect() as con:
                visao.exigir_pedido(con, pid, gravar=True)
        try:
            iid = int(f.get("item_id") or 0) or None
        except ValueError:
            iid = None
        if "classe_numero" in f:   # formulário com listas suspensas (centro de custo, projeto, classe)
            with db.connect() as con:
                iid = item_id(con, f.get("centro_custo"), f.get("projeto"), f.get("classe_numero"))
        campos = {"numero": numero, "data_emissao": importer.data_iso(f.get("data_emissao")) or "", "valor": importer.num(f.get("valor")),
                  "motivo": importer.up(f.get("motivo")), "item_id": iid, "fornecedor": importer.up(f.get("fornecedor")),
                  "observacao": importer.txt(f.get("observacao")), "status": "CANCELADO" if f.get("status") == "CANCELADO" else "ATIVO"}
        if "classe_numero" in f:   # sem classe: guarda projeto / centro de custo escolhidos para quando a classe vier
            campos["projeto_pend"] = "" if iid else _cod(f.get("projeto"))
            campos["cc_pend"] = "" if iid else _cod(f.get("centro_custo"))
        for k in ("cnpj", "processo", "descricao"):
            if k in f:
                campos[k] = importer.txt(f.get(k))
        arq = request.files.get("arquivo")
        with db.connect() as con:
            outro = con.execute("SELECT id FROM bud_pedidos WHERE numero=?", (numero,)).fetchone()
            if outro and outro["id"] != pid:
                return jsonify(erro=f"Já existe o pedido {numero}."), 409
            if pid:
                con.execute(f"UPDATE bud_pedidos SET {', '.join(k + '=?' for k in campos)} WHERE id=?", (*campos.values(), pid))
            else:
                pid = con.execute(f"INSERT INTO bud_pedidos({', '.join(campos)}) VALUES ({', '.join('?' * len(campos))})", tuple(campos.values())).lastrowid
            if arq and arq.filename:
                antigo = con.execute("SELECT anexo_arquivo FROM bud_pedidos WHERE id=?", (pid,)).fetchone()["anexo_arquivo"]
                destino = f"{pid}_{uuid.uuid4().hex[:8]}_{secure_filename(arq.filename) or 'pedido' + Path(arq.filename).suffix}"
                PEDIDOS_DIR.mkdir(parents=True, exist_ok=True)
                arq.save(PEDIDOS_DIR / destino)
                con.execute("UPDATE bud_pedidos SET anexo_arquivo=?, anexo_nome=? WHERE id=?", (destino, arq.filename, pid))
                if antigo:
                    (PEDIDOS_DIR / antigo).unlink(missing_ok=True)
        return jsonify(ok=True, id=pid)

    @app.delete("/api/budget/pedidos/<int:pid>")
    @guarda_pedidos
    def bud_excluir_pedido(pid):
        with db.connect() as con:
            visao.exigir_pedido(con, pid)
            r = con.execute("SELECT anexo_arquivo FROM bud_pedidos WHERE id=?", (pid,)).fetchone()
            con.execute("DELETE FROM bud_pedidos WHERE id=?", (pid,))
        if r and r["anexo_arquivo"]:
            lixeira.guardar(PEDIDOS_DIR / r["anexo_arquivo"])
        return jsonify(ok=True)

    @app.post("/api/budget/pedidos/excluir")
    @guarda_pedidos
    def bud_excluir_pedidos():
        """{ids: [...]} — exclui vários pedidos (e os anexos)."""
        ids = [int(x) for x in corpo().get("ids") or []]
        arquivos = []
        with db.connect() as con:
            for pid in ids:
                visao.exigir_pedido(con, pid)
                r = con.execute("SELECT anexo_arquivo FROM bud_pedidos WHERE id=?", (pid,)).fetchone()
                if r and r["anexo_arquivo"]:
                    arquivos.append(r["anexo_arquivo"])
                con.execute("UPDATE nf_medicoes SET pedido_id=NULL WHERE pedido_id=?", (pid,))
                con.execute("DELETE FROM bud_pedidos WHERE id=?", (pid,))
        for a in arquivos:
            lixeira.guardar(PEDIDOS_DIR / a)
        return jsonify(ok=True, n=len(ids))

    @app.get("/api/budget/pedidos/<int:pid>/anexo")
    @guarda_pedidos
    def bud_anexo_pedido(pid):
        with db.connect() as con:
            visao.exigir_pedido(con, pid)
            r = con.execute("SELECT * FROM bud_pedidos WHERE id=?", (pid,)).fetchone()
        if not r:
            abort(404)
        if r["anexo_arquivo"] and (PEDIDOS_DIR / r["anexo_arquivo"]).exists():
            return seguranca.enviar_anexo(PEDIDOS_DIR / r["anexo_arquivo"], r["anexo_nome"])
        p = seguranca.arquivo_externo(r["caminho_externo"])
        if p:
            return seguranca.enviar_anexo(p)
        abort(404, "Arquivo do pedido não encontrado.")

    # ---- pedido lido do PDF
    @app.post("/api/budget/pedidos/ler-pdf")
    @guarda_pedidos
    def bud_ler_pdf():
        """Lê os PDFs de pedido e devolve os campos para conferir (não grava nada)."""
        arqs = [(f.filename, f.read()) for f in request.files.getlist("arquivo") if f and f.filename]
        if not arqs:
            abort(400, "Envie o(s) PDF(s) do pedido.")
        with db.connect() as con:
            return jsonify(ler_pdfs(con, arqs))

    @app.post("/api/budget/pedidos/pdf")
    @guarda_pedidos
    def bud_salvar_pdf():
        """Grava um pedido conferido: form 'dados' (JSON) + 'arquivo' (o PDF, vira o anexo)."""
        import json
        d = json.loads(request.form.get("dados") or "{}")
        f = request.files.get("arquivo")
        try:
            with db.connect() as con:
                pid, novo = salvar_pedido_lido(con, d, (f.filename, f.read()) if f and f.filename else None)
        except ValueError as ex:
            return jsonify(erro=str(ex)), 400
        return jsonify(ok=True, id=pid, novo=novo)

    # ---- realocações
    @app.get("/api/budget/realocacoes")
    @guarda
    def bud_realocacoes():
        ano = request.args.get("ano")
        with db.connect() as con:
            q = "SELECT * FROM bud_realocacoes" + (" WHERE substr(data,1,4)=?" if ano else "") + " ORDER BY data DESC, id DESC"
            visiveis = visao.ids_itens(con)
            return jsonify([dict(r) for r in con.execute(q, (ano,) if ano else ())
                            if visiveis is None or r["origem_id"] in visiveis or r["destino_id"] in visiveis])

    def _exigir_realocacao(con, rid):
        r = con.execute("SELECT origem_id, destino_id FROM bud_realocacoes WHERE id=?", (rid,)).fetchone()
        visiveis = visao.ids_itens(con)
        if r and visiveis is not None and not ({r["origem_id"], r["destino_id"]} & visiveis):
            abort(404, "Registro não encontrado.")

    @app.post("/api/budget/realocacoes")
    @guarda
    def bud_salvar_realocacao():
        d = corpo()
        data = importer.data_iso(d.get("data"))
        valor = importer.num(d.get("valor"))
        o, de = int(d.get("origem_id") or 0) or None, int(d.get("destino_id") or 0) or None
        if not data or valor <= 0 or not (o or de) or o == de:
            abort(400, "Informe data, valor (maior que zero) e classes de origem e destino diferentes.")
        with db.connect() as con:
            for iid in (o, de):
                if iid:
                    visao.exigir_item(con, iid)
            if d.get("id"):
                _exigir_realocacao(con, int(d["id"]))
                con.execute("UPDATE bud_realocacoes SET data=?, origem_id=?, destino_id=?, valor=?, motivo=? WHERE id=?",
                            (data, o, de, valor, importer.txt(d.get("motivo")), int(d["id"])))
            else:
                con.execute("INSERT INTO bud_realocacoes(data, origem_id, destino_id, valor, motivo) VALUES (?,?,?,?,?)",
                            (data, o, de, valor, importer.txt(d.get("motivo"))))
        return jsonify(ok=True)

    @app.delete("/api/budget/realocacoes/<int:rid>")
    @guarda
    def bud_excluir_realocacao(rid):
        with db.connect() as con:
            _exigir_realocacao(con, rid)
            con.execute("DELETE FROM bud_realocacoes WHERE id=?", (rid,))
        return jsonify(ok=True)

    # ---- Excel
    @app.get("/api/budget/exportar")
    @guarda_pedidos
    def bud_exportar():
        tipo = (request.args.get("tipo") or "tudo").lower()
        if tipo != "pedidos" and not getattr(guarda_pedidos, "tem_budget", lambda: True)():
            return jsonify(erro="Sem acesso ao Budget."), 403
        quais = TIPOS_EXCEL.get(tipo, TODAS)
        ano = request.args.get("ano") if tipo != "cadastros" else None
        with db.connect() as con:
            buf = gerar_excel(con, quais, int(ano) if ano else None, filtro={k: request.args.get(k) for k in ("de", "ate", "cc", "projeto")})
        rot = {"budget": "Budget", "pedidos": "Pedidos", "realocacoes": "Realocações", "cadastros": "Cadastros"}.get(tipo, "Budget completo")
        nome = f"{rot}{' ' + ano if ano else ''} - Central de Engenharia.xlsx"
        return send_file(buf, as_attachment=True, download_name=nome,
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.get("/api/budget/modelo")
    @guarda
    def bud_modelo():
        tipo = (request.args.get("tipo") or "tudo").lower()
        with db.connect() as con:
            buf = gerar_excel(con, TIPOS_EXCEL.get(tipo, TODAS), modelo=True)
        nome = NOMES_MODELO.get(tipo, "BUDGET, PEDIDOS, REALOCAÇÕES E CADASTROS")
        return send_file(buf, as_attachment=True, download_name=f"PLANILHA DE IMPORTAÇÃO (EXEMPLO) - {nome}.xlsx",
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.post("/api/budget/importar")
    @guarda
    def bud_importar():
        f = request.files.get("arquivo")
        if not f:
            abort(400, "Envie a planilha.")
        tmp = db.DATA_DIR / f"_bud_{uuid.uuid4().hex}{Path(f.filename or 'x.xlsx').suffix}"
        f.save(tmp)
        try:
            with db.connect() as con:
                res = importar_excel(con, tmp)
            registrar("importou planilha do budget", f"{f.filename}: {res['budget_novos']} linhas novas, {res['pedidos']} pedidos, {res['realocacoes']} realocações, {res['cadastros']} cadastros")
            return jsonify(res)
        except Exception as ex:
            return jsonify(erro=f"Não consegui importar: {ex}"), 400
        finally:
            tmp.unlink(missing_ok=True)

    # ---- classe financeira nas medições/contratos de NF
    @app.post("/api/budget/vincular")
    @guarda
    def bud_vincular():
        """Medição: {tipo:'medicao', id, contrato_item_id, centro_custo, projeto, classe_numero} (classe só desta medição,
        vazia = usa a do item / do contrato). Contrato (modo antigo): {tipo:'contrato', id, item_id}."""
        d = corpo()
        with db.connect() as con:
            if d.get("tipo") == "contrato":
                visao.exigir_contrato(con, int(d["id"]), gravar=True)
                con.execute("UPDATE nf_contratos SET budget_item_id=? WHERE id=?", (int(d.get("item_id") or 0) or None, int(d["id"])))
            elif d.get("tipo") == "medicao":
                visao.exigir_medicao(con, int(d["id"]), gravar=True)
                m = con.execute("SELECT contrato_id FROM nf_medicoes WHERE id=?", (int(d["id"]),)).fetchone()
                if not m:
                    abort(404)
                ci = int(d.get("contrato_item_id") or 0) or None
                if ci and not con.execute("SELECT 1 FROM nf_contrato_itens WHERE id=? AND contrato_id=?", (ci, m["contrato_id"])).fetchone():
                    ci = None
                if "classe_numero" in d:
                    iid = item_id(con, d.get("centro_custo"), d.get("projeto"), d.get("classe_numero"))
                else:
                    iid = int(d.get("item_id") or 0) or None
                con.execute("UPDATE nf_medicoes SET contrato_item_id=?, budget_item_id=? WHERE id=?", (ci, iid, int(d["id"])))
            else:
                abort(400)
        return jsonify(ok=True)

    # ------------------------------------------------------------------ rateio (NF de medição ou pedido de compra)
    RAT = {"medicao": ("nf_rateio", "medicao_id", "nf_medicoes", "budget_item_id"),
           "pedido": ("bud_pedido_rateio", "pedido_id", "bud_pedidos", "item_id")}

    def _exigir_rateio(con, tipo, rid, gravar=False):
        (visao.exigir_medicao if tipo == "medicao" else visao.exigir_pedido)(con, rid, gravar=gravar)

    def _rateio(con, tipo, rid):
        t, col, _, _ = RAT[tipo]
        return [dict(r) for r in con.execute(f"""SELECT r.item_id, r.pct, r.valor, i.centro_custo, i.projeto, i.classe_numero, i.classe_descricao
            FROM {t} r JOIN bud_itens i ON i.id = r.item_id WHERE r.{col}=? ORDER BY r.id""", (rid,))]

    @app.get("/api/budget/rateio")
    @guarda_pedidos
    def bud_ler_rateio():
        tipo, rid = request.args.get("tipo"), int(request.args.get("id") or 0)
        if tipo not in RAT:
            abort(400)
        with db.connect() as con:
            _exigir_rateio(con, tipo, rid, gravar=True)
            return jsonify(_rateio(con, tipo, rid))

    @app.post("/api/budget/rateio")
    @guarda_pedidos
    def bud_gravar_rateio():
        """{tipo:'medicao'|'pedido', id, modo:'pct'|'valor', linhas:[{centro_custo, projeto, classe_numero, pct | valor}]}.
        Sem linhas = tira o rateio. As partes precisam fechar 100% (ou o valor total). A classe principal da NF / do pedido
        fica sendo a da maior parte (é a que aparece onde não há espaço para o rateio)."""
        d = corpo()
        tipo = d.get("tipo")
        if tipo not in RAT:
            abort(400)
        t, col, tab, col_item = RAT[tipo]
        rid = int(d.get("id") or 0)
        with db.connect() as con:
            reg = con.execute(f"SELECT valor FROM {tab} WHERE id=?", (rid,)).fetchone()
            if not reg:
                abort(404)
            linhas = [l for l in (d.get("linhas") or []) if l.get("classe_numero")]
            con.execute(f"DELETE FROM {t} WHERE {col}=?", (rid,))
            if not linhas:
                return jsonify(ok=True, linhas=[])
            if len(linhas) < 2:
                abort(400, "O rateio precisa de pelo menos duas linhas (com uma só, use a classe normal).")
            total = reg["valor"] or 0
            por_valor = d.get("modo") == "valor"
            partes = []
            for l in linhas:
                iid = item_id(con, l.get("centro_custo"), l.get("projeto"), l.get("classe_numero"))
                v = importer.num(l.get("valor")) if por_valor else None
                pct = (100.0 * v / total if total else 0) if por_valor else importer.num(l.get("pct"))
                if (v if por_valor else pct) is None or (v if por_valor else pct) <= 0:
                    abort(400, "Preencha o " + ("valor" if por_valor else "%") + " de todas as linhas do rateio (maior que zero).")
                partes.append((iid, pct, v))
            if por_valor:
                soma = sum(p[2] for p in partes)
                if not total:
                    abort(400, "Preencha o valor antes de ratear por valor.")
                if abs(soma - total) > 0.01:
                    abort(400, f"A soma do rateio (R$ {soma:,.2f}) não fecha com o valor total (R$ {total:,.2f}).".replace(",", "X").replace(".", ",").replace("X", "."))
            elif abs(sum(p[1] for p in partes) - 100) > 0.01:
                abort(400, f"A soma dos percentuais dá {sum(p[1] for p in partes):.2f}%: precisa fechar 100%.".replace(".", ","))
            for iid, pct, v in partes:
                con.execute(f"INSERT INTO {t}({col}, item_id, pct, valor) VALUES (?,?,?,?)", (rid, iid, pct, v))
            principal = max(partes, key=lambda p: p[1])[0]
            con.execute(f"UPDATE {tab} SET {col_item}=? WHERE id=?", (principal, rid))
            return jsonify(ok=True, linhas=_rateio(con, tipo, rid))

    def _info_item(con, iid):
        if not iid:
            return None
        r = con.execute("SELECT * FROM bud_itens WHERE id=?", (iid,)).fetchone()
        return dict(r) if r else None

    @app.get("/api/budget/contrato/<int:cid>")
    @guarda
    def bud_contrato(cid):
        """Classe padrão do contrato e os itens (linhas) dele, cada um com centro de custo / projeto / classe."""
        with db.connect() as con:
            visao.exigir_contrato(con, cid, gravar=True)
            c = con.execute("SELECT budget_item_id FROM nf_contratos WHERE id=?", (cid,)).fetchone()
            if not c:
                abort(404)
            lista = []
            for r in con.execute("""SELECT ci.*, (SELECT COUNT(*) FROM nf_medicoes m WHERE m.contrato_item_id=ci.id) AS n_medicoes
                                    FROM nf_contrato_itens ci WHERE ci.contrato_id=? ORDER BY ci.ordem, ci.id""", (cid,)):
                i = _info_item(con, r["budget_item_id"]) or {}
                lista.append({**dict(r), **{k: i.get(k, "") for k in ("centro_custo", "projeto", "classe_numero", "classe_descricao")}})
            return jsonify(padrao=_info_item(con, c["budget_item_id"]), itens=lista)

    @app.post("/api/budget/contrato/<int:cid>")
    @guarda
    def bud_salvar_contrato(cid):
        """{padrao: {centro_custo, projeto, classe_numero} | null, itens: [{id?, numero, descricao, centro_custo, projeto, classe_numero}]}
        Item tirado da lista: as medições dele voltam a usar a classe padrão do contrato."""
        d = corpo()
        with db.connect() as con:
            visao.exigir_contrato(con, cid, gravar=True)
            if not con.execute("SELECT 1 FROM nf_contratos WHERE id=?", (cid,)).fetchone():
                abort(404)
            p = d.get("padrao") or {}
            con.execute("UPDATE nf_contratos SET budget_item_id=? WHERE id=?",
                        (item_id(con, p.get("centro_custo"), p.get("projeto"), p.get("classe_numero")), cid))
            nums = [_txt(it.get("numero")) for it in d.get("itens") or [] if _txt(it.get("numero"))]
            rep = sorted({n for n in nums if nums.count(n) > 1})
            if rep:
                abort(400, f"Item repetido no contrato: {', '.join(rep)}. Cada item precisa de um número diferente.")
            existentes = {r[0] for r in con.execute("SELECT id FROM nf_contrato_itens WHERE contrato_id=?", (cid,))}
            mantidos = set()
            for k, it in enumerate(d.get("itens") or []):
                numero, desc = _txt(it.get("numero")), importer.txt(it.get("descricao"))
                if not numero and not desc:
                    continue
                iid = item_id(con, it.get("centro_custo"), it.get("projeto"), it.get("classe_numero"))
                xid = int(it.get("id") or 0)
                if xid in existentes:
                    con.execute("UPDATE nf_contrato_itens SET numero=?, descricao=?, budget_item_id=?, ordem=? WHERE id=?",
                                (numero, desc, iid, k, xid))
                    mantidos.add(xid)
                else:
                    con.execute("INSERT INTO nf_contrato_itens(contrato_id, numero, descricao, budget_item_id, ordem) VALUES (?,?,?,?,?)",
                                (cid, numero, desc, iid, k))
            for xid in existentes - mantidos:
                con.execute("UPDATE nf_medicoes SET contrato_item_id=NULL WHERE contrato_item_id=?", (xid,))
                con.execute("DELETE FROM nf_contrato_itens WHERE id=?", (xid,))
            n = sincronizar_medicoes_contrato(con, cid)
        return jsonify(ok=True, medicoes_atualizadas=n)

    @app.get("/api/budget/fora")
    @guarda
    def bud_fora():
        """O que tem classe mas não está no budget do ano (valor não calculado) + o que está sem classe."""
        ano = request.args.get("ano")
        with db.connect() as con:
            return jsonify(fora_budget(con, int(ano) if ano else None))

    # ---- cadastros (listas suspensas)
    CAD = {"centros": ("bud_centros", "nome", "centro_custo"), "projetos": ("bud_projetos", "nome", "projeto"),
           "classes": ("bud_classes", "numero", "classe_numero")}

    @app.get("/api/budget/cadastros")
    @guarda_pedidos
    def bud_cadastros():
        with db.connect() as con:
            return jsonify(cadastros(con))

    @app.post("/api/budget/cadastros/<tipo>")
    @guarda
    def bud_salvar_cadastro(tipo):
        """Cria ou edita. Renomear atualiza as linhas do budget, pedidos, contratos e medições que usam o nome."""
        if tipo not in CAD:
            abort(404)
        tabela, chave, col_item = CAD[tipo]
        d = corpo()
        valor = _txt(d.get(chave)) if tipo == "classes" else _cod(d.get(chave))
        if not valor:
            abort(400, "Informe o número.")
        extra = {"centros": {"descricao": importer.up(d.get("descricao")), "observacao": importer.txt(d.get("observacao"))},
                 "projetos": {"descricao": importer.up(d.get("descricao")), "centro_custo": _cod(d.get("centro_custo")),
                              "observacao": importer.txt(d.get("observacao"))},
                 "classes": {"descricao": importer.up(d.get("descricao"))}}[tipo]
        con = db.connect()
        try:
            outro = con.execute(f"SELECT id FROM {tabela} WHERE {chave}=?", (valor,)).fetchone()
            xid = int(d.get("id") or 0)
            if outro and outro["id"] != xid:
                return jsonify(erro=f"“{valor}” já está cadastrado."), 409
            if xid:
                antigo = con.execute(f"SELECT {chave} FROM {tabela} WHERE id=?", (xid,)).fetchone()[0]
                con.execute(f"UPDATE {tabela} SET {chave}=?, {', '.join(k + '=?' for k in extra)} WHERE id=?", (valor, *extra.values(), xid))
                if antigo != valor:
                    con.execute(f"UPDATE bud_itens SET {col_item}=? WHERE {col_item}=?", (valor, antigo))
                    if tipo != "classes":
                        visao.renomear(con, tipo, antigo, valor)
                    if tipo == "centros":
                        con.execute("UPDATE bud_projetos SET centro_custo=? WHERE centro_custo=?", (valor, antigo))
            else:
                con.execute(f"INSERT INTO {tabela}({chave}, {', '.join(extra)}) VALUES (?{', ?' * len(extra)})", (valor, *extra.values()))
            if tipo == "classes":
                con.execute("UPDATE bud_itens SET classe_descricao=? WHERE classe_numero=?", (extra["descricao"], valor))
            if tipo == "projetos" and extra["centro_custo"]:
                con.execute("INSERT OR IGNORE INTO bud_centros(nome) VALUES (?)", (extra["centro_custo"],))
            con.commit()
        except db.sqlite3.IntegrityError:
            con.rollback()
            return jsonify(erro="Já existem linhas do budget com esse novo nome (mesmo centro de custo, projeto e classe). "
                                "Não dá para juntar automaticamente."), 409
        finally:
            con.close()
        return jsonify(ok=True)

    def _uso_cadastro(con, col_item, valor):
        ids = [r[0] for r in con.execute(f"SELECT id FROM bud_itens WHERE {col_item}=?", (valor,))]
        q = ",".join("?" * len(ids)) or "NULL"
        conta = lambda sql: con.execute(sql.format(q=q), ids).fetchone()[0] if ids else 0
        return ids, {
            "linhas_budget": conta("SELECT COUNT(DISTINCT item_id) FROM bud_previsto WHERE item_id IN ({q})"),
            "pedidos": conta("SELECT COUNT(*) FROM bud_pedidos WHERE item_id IN ({q})")
                       + conta("SELECT COUNT(DISTINCT pedido_id) FROM bud_pedido_rateio WHERE item_id IN ({q})"),
            "medicoes": conta("SELECT COUNT(*) FROM nf_medicoes WHERE budget_item_id IN ({q})") + conta("SELECT COUNT(DISTINCT medicao_id) FROM nf_rateio WHERE item_id IN ({q})"),
            "contratos": conta("SELECT COUNT(*) FROM nf_contratos WHERE budget_item_id IN ({q})")
                         + conta("SELECT COUNT(*) FROM nf_contrato_itens WHERE budget_item_id IN ({q})"),
        }

    @app.get("/api/budget/cadastros/<tipo>/<int:xid>/uso")
    @guarda
    def bud_uso_cadastro(tipo, xid):
        if tipo not in CAD:
            abort(404)
        tabela, chave, col_item = CAD[tipo]
        with db.connect() as con:
            r = con.execute(f"SELECT {chave} FROM {tabela} WHERE id=?", (xid,)).fetchone()
            if not r:
                abort(404)
            _, uso = _uso_cadastro(con, col_item, r[0])
            extra = con.execute("SELECT COUNT(*) FROM bud_projetos WHERE centro_custo=?", (r[0],)).fetchone()[0] if tipo == "centros" else 0
            return jsonify(uso=uso, projetos=extra, total=sum(uso.values()))

    def _excluir_cadastro(tipo, xid, modo, para):
        """Exclui um cadastro (uso: transferir para outro ou desvincular). Devolve None ou a resposta de erro."""
        tabela, chave, col_item = CAD[tipo]
        refs = (("bud_pedidos", "item_id"), ("nf_medicoes", "budget_item_id"), ("nf_contratos", "budget_item_id"),
                ("nf_contrato_itens", "budget_item_id"), ("bud_realocacoes", "origem_id"), ("bud_realocacoes", "destino_id"),
                ("nf_rateio", "item_id"), ("bud_pedido_rateio", "item_id"))
        with db.connect() as con:
            r = con.execute(f"SELECT {chave} FROM {tabela} WHERE id=?", (xid,)).fetchone()
            if not r:
                return None
            velho = r[0]
            ids, uso = _uso_cadastro(con, col_item, velho)
            if sum(uso.values()) and modo not in ("transferir", "desvincular"):
                return jsonify(erro=f"“{velho}” está em uso.", uso=uso), 409
            if modo == "transferir":
                if not para or para == velho or not con.execute(f"SELECT 1 FROM {tabela} WHERE {chave}=?", (para,)).fetchone():
                    abort(400, "Escolha para qual cadastro transferir.")
                if tipo != "classes":
                    visao.renomear(con, tipo, velho, para)
                for iid in ids:
                    it = dict(con.execute("SELECT * FROM bud_itens WHERE id=?", (iid,)).fetchone())
                    it[col_item] = para
                    alvo = con.execute("SELECT id FROM bud_itens WHERE centro_custo=? AND projeto=? AND classe_numero=? AND id<>?",
                                       (it["centro_custo"], it["projeto"], it["classe_numero"], iid)).fetchone()
                    if not alvo:   # combinação nova: só troca o valor
                        con.execute(f"UPDATE bud_itens SET {col_item}=? WHERE id=?", (para, iid))
                        continue
                    aid = alvo[0]  # a combinação já existe: junta tudo nela (valores do budget somados)
                    for ano, valor, sol in con.execute("SELECT ano, valor, solicitado FROM bud_previsto WHERE item_id=?", (iid,)).fetchall():
                        if con.execute("SELECT 1 FROM bud_previsto WHERE ano=? AND item_id=?", (ano, aid)).fetchone():
                            con.execute("""UPDATE bud_previsto SET valor = CASE WHEN valor IS NULL AND ? IS NULL THEN NULL ELSE COALESCE(valor,0)+COALESCE(?,0) END,
                                           solicitado = CASE WHEN solicitado IS NULL AND ? IS NULL THEN NULL ELSE COALESCE(solicitado,0)+COALESCE(?,0) END
                                           WHERE ano=? AND item_id=?""", (valor, valor, sol, sol, ano, aid))
                        else:
                            con.execute("INSERT INTO bud_previsto(ano, item_id, valor, solicitado) VALUES (?,?,?,?)", (ano, aid, valor, sol))
                    con.execute("DELETE FROM bud_previsto WHERE item_id=?", (iid,))
                    for t, c in refs:
                        con.execute(f"UPDATE {t} SET {c}=? WHERE {c}=?", (aid, iid))
                    con.execute("DELETE FROM bud_itens WHERE id=?", (iid,))
                if tipo == "centros":
                    con.execute("UPDATE bud_projetos SET centro_custo=? WHERE centro_custo=?", (para, velho))
            else:          # desvincular (ou sem uso)
                for iid in ids:
                    # NF / pedido rateado que usa essa linha: o rateio inteiro sai (volta para a classe principal)
                    con.execute("DELETE FROM nf_rateio WHERE medicao_id IN (SELECT medicao_id FROM nf_rateio WHERE item_id=?)", (iid,))
                    con.execute("DELETE FROM bud_pedido_rateio WHERE pedido_id IN (SELECT pedido_id FROM bud_pedido_rateio WHERE item_id=?)", (iid,))
                    for t, c in refs[:4]:
                        con.execute(f"UPDATE {t} SET {c}=NULL WHERE {c}=?", (iid,))
                    con.execute("DELETE FROM bud_realocacoes WHERE origem_id=? OR destino_id=?", (iid, iid))
                    con.execute("DELETE FROM bud_previsto WHERE item_id=?", (iid,))
                con.execute(f"DELETE FROM bud_itens WHERE {col_item}=?", (velho,))
                if tipo == "centros":
                    con.execute("UPDATE bud_projetos SET centro_custo='' WHERE centro_custo=?", (velho,))
            con.execute(f"DELETE FROM {tabela} WHERE id=?", (xid,))
        return None

    @app.delete("/api/budget/cadastros/<tipo>/<int:xid>")
    @guarda
    def bud_excluir_cadastro(tipo, xid):
        """Exclui da lista. Em uso: ?modo=transferir&para=<outro> passa tudo para o outro (linhas iguais são somadas);
        ?modo=desvincular tira das linhas do budget, pedidos, medições e contratos (ficam sem classe)."""
        if tipo not in CAD:
            abort(404)
        erro = _excluir_cadastro(tipo, xid, request.args.get("modo") or "", _txt(request.args.get("para")))
        return erro or jsonify(ok=True)

    @app.post("/api/budget/cadastros/<tipo>/uso")
    @guarda
    def bud_uso_varios(tipo):
        """Uso somado de vários cadastros (excluir em lote)."""
        if tipo not in CAD:
            abort(404)
        tabela, chave, col_item = CAD[tipo]
        tot, proj = {}, 0
        with db.connect() as con:
            for xid in corpo().get("ids") or []:
                r = con.execute(f"SELECT {chave} FROM {tabela} WHERE id=?", (int(xid),)).fetchone()
                if not r:
                    continue
                _, uso = _uso_cadastro(con, col_item, r[0])
                for k, v in uso.items():
                    tot[k] = tot.get(k, 0) + v
                if tipo == "centros":
                    proj += con.execute("SELECT COUNT(*) FROM bud_projetos WHERE centro_custo=?", (r[0],)).fetchone()[0]
        return jsonify(uso=tot, projetos=proj, total=sum(tot.values()))

    @app.post("/api/budget/cadastros/<tipo>/excluir")
    @guarda
    def bud_excluir_varios(tipo):
        """{ids, modo, para}: exclui vários de uma vez."""
        if tipo not in CAD:
            abort(404)
        d = corpo()
        n = 0
        for xid in d.get("ids") or []:
            erro = _excluir_cadastro(tipo, int(xid), d.get("modo") or "", _txt(d.get("para")))
            if erro:
                return erro
            n += 1
        return jsonify(ok=True, n=n)
