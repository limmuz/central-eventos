import re
"""Notas fiscais: contratos, medições, prazos de recebimento, feriados, configurações e e-mails.

Regras (as mesmas da planilha EnviarEmailNF, com os números ajustáveis na aba Configurações):
- DIAS ÚTEIS = dias úteis entre a emissão e a medição (sem contar o dia da emissão, sem fins de
  semana e sem os feriados cadastrados). Fica gravado na medição e é recalculado quando muda um
  feriado ou a medição.
- SLA de envio: até N dias úteis (padrão 3) = "No prazo"; mais que isso = "Atrasado".
- Medição atrasada com observação = "Com justificativa"; sem observação = "Sem justificativa".
- SLA de recebimento: a NF foi emitida até o prazo de recebimento do mês da emissão?
- Contrato: saldo atual = (saldo contratado + aditivo) - medições (as canceladas não contam).
- E-mails: o site gera um arquivo .eml já redigido (destinatários da aba Configurações e NF anexada).
  Ao abrir no novo Outlook, a mensagem vem pronta para conferir e enviar, com o anexo.

Desempenho: a lista de medições é filtrada, ordenada e paginada no banco; os gráficos e os totais
dos contratos são somados com SQL (GROUP BY). Assim o site continua rápido com muitos anos de dados.
"""
import datetime as dt
import mimetypes
import uuid
import email.policy
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from html import escape
from io import BytesIO
from pathlib import Path

from flask import abort, jsonify, request, send_file
from werkzeug.utils import secure_filename

import db
import importer
import lixeira
import seguranca
import visao

STATUS = ("PROSSEGUIU", "PENDENTE", "CANCELADA")
MESES = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO",
         "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"]

# valores iniciais da aba Configurações (os e-mails vêm da macro antiga)
CONFIG_PADRAO = {
    "sla_dias_uteis": "3",            # SLA da emissão até a medição
    "dias_liberacao": "7",            # "liberar para o financeiro até" = vencimento - N dias
    "alerta_saldo_pct": "10",         # alerta quando o saldo atual ficar em até X% do total
    "alerta_saldo_valor": "0",        # ... ou em até R$ X (0 = não usa)
    "alerta_vencimento_dias": "60",   # alerta quando faltar até X dias para o fim do contrato
    "email_nf_para": "fiscal@empresa-demo.com.br",
    "email_nf_cc": "",
    "email_nf_cco": "",
    "email_forn_para": "",
    "email_forn_cc": "",
    "email_forn_cco": "",
}
NUMERICOS = {"sla_dias_uteis", "dias_liberacao", "alerta_saldo_pct", "alerta_saldo_valor", "alerta_vencimento_dias"}


# ----------------------------------------------------------------------------- configurações
def config(con):
    c = dict(CONFIG_PADRAO)
    c.update({r["chave"]: r["valor"] for r in con.execute("SELECT chave, valor FROM nf_config") if r["chave"] in CONFIG_PADRAO})
    return c


def cfg_num(c, chave):
    try:
        return float(str(c.get(chave) or 0).replace(",", "."))
    except ValueError:
        return float(CONFIG_PADRAO[chave])


# ----------------------------------------------------------------------------- dias úteis
def _d(txt):
    try:
        return dt.date.fromisoformat((txt or "")[:10])
    except ValueError:
        return None


def dias_uteis(inicio, fim, feriados):
    """Igual a NETWORKDAYS(inicio, fim, feriados) - 1 do Excel."""
    a, b = _d(inicio), _d(fim)
    if not a or not b:
        return None
    sinal = 1
    if b < a:
        a, b, sinal = b, a, -1
    total = (b - a).days + 1
    semanas, resto = divmod(total, 7)
    n = semanas * 5 + sum(1 for i in range(resto) if (a + dt.timedelta(days=semanas * 7 + i)).weekday() < 5)
    n -= sum(1 for f in feriados if a.isoformat() <= f <= b.isoformat() and _d(f) and _d(f).weekday() < 5)
    return sinal * (n - 1) if n else 0


def _feriados(con):
    return {r["data"] for r in con.execute("SELECT data FROM nf_feriados")}


def recalcular_dias_uteis(con, ids=None, so_vazios=False):
    fer = _feriados(con)
    q = "SELECT id, data_emissao, data_medicao FROM nf_medicoes"
    args = ()
    if ids:
        q += f" WHERE id IN ({','.join('?' * len(ids))})"
        args = tuple(ids)
    elif so_vazios:
        q += " WHERE dias_uteis IS NULL AND data_emissao<>'' AND data_medicao<>''"
    linhas = con.execute(q, args).fetchall()
    con.executemany("UPDATE nf_medicoes SET dias_uteis=? WHERE id=?",
                    [(dias_uteis(r["data_emissao"], r["data_medicao"], fer), r["id"]) for r in linhas])
    return len(linhas)


def atualizar_busca(con, ids=None, contrato_id=None, so_vazios=False):
    """Guarda um texto sem acentos (medição, NF, fornecedor, contrato, observação) para a busca ser rápida."""
    q = ("SELECT m.id, m.numero_medicao, m.numero_documento, m.observacao, COALESCE(c.fornecedor, pd.fornecedor) AS fornecedor, "
         "COALESCE(c.numero, 'pedido ' || pd.numero) AS numero "
         "FROM nf_medicoes m LEFT JOIN nf_contratos c ON c.id=m.contrato_id LEFT JOIN bud_pedidos pd ON pd.id=m.pedido_id")
    args = ()
    if ids:
        q += f" WHERE m.id IN ({','.join('?' * len(ids))})"; args = tuple(ids)
    elif contrato_id:
        q += " WHERE m.contrato_id=?"; args = (contrato_id,)
    elif so_vazios:
        q += " WHERE m.busca='' OR m.busca IS NULL"
    con.executemany("UPDATE nf_medicoes SET busca=? WHERE id=?", [
        (_norm(" ".join(str(r[k] or "") for k in ("numero_medicao", "numero_documento", "fornecedor", "numero", "observacao"))), r["id"])
        for r in con.execute(q, args).fetchall()])


def _num_txt(v):
    """1288.0 -> '1288'; texto fica como está."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return importer.txt(v)


# ----------------------------------------------------------------------------- consultas
def contratos(con, cfg=None):
    """Contratos com totais (somados no banco) e alertas de saldo e vencimento."""
    cfg = cfg or config(con)
    pct, valor_min, dias_alerta = cfg_num(cfg, "alerta_saldo_pct"), cfg_num(cfg, "alerta_saldo_valor"), cfg_num(cfg, "alerta_vencimento_dias")
    hoje = dt.date.today()
    lista = []
    cond_v, par_v = visao.cond_contrato()
    for r in con.execute(f"""
        SELECT c.*,
               COALESCE(SUM(CASE WHEN m.status<>'CANCELADA' THEN m.valor END), 0) AS total_utilizado,
               COUNT(CASE WHEN m.status<>'CANCELADA' THEN 1 END)                 AS n_medicoes,
               MAX(CASE WHEN m.status<>'CANCELADA' THEN m.data_medicao END)       AS ultima_medicao,
               (SELECT COUNT(*) FROM nf_contrato_itens ci WHERE ci.contrato_id = c.id) AS n_itens
        FROM nf_contratos c LEFT JOIN nf_medicoes m ON m.contrato_id = c.id
        WHERE {cond_v} GROUP BY c.id ORDER BY c.finalizado, c.fornecedor""", par_v):
        c = dict(r)
        c["total_utilizado"] = round(c["total_utilizado"], 2)
        c["total_contratado"] = round((c["saldo_contratado"] or 0) + (c["aditivo"] or 0), 2)
        c["saldo_atual"] = round(c["total_contratado"] - c["total_utilizado"], 2)
        c["saldo_restante"] = c["saldo_atual"]
        c["pct_utilizado"] = round(100 * c["total_utilizado"] / c["total_contratado"], 1) if c["total_contratado"] else None
        c["pct_saldo"] = round(100 * c["saldo_atual"] / c["total_contratado"], 1) if c["total_contratado"] else None
        fim = _d(c["data_fim"])
        c["dias_para_vencer"] = (fim - hoje).days if fim else None
        alertas = []
        if not c["finalizado"]:
            if c["saldo_atual"] < 0:            # inclui contrato sem saldo cadastrado que já tem medições
                alertas.append("saldo_negativo")
            elif c["total_contratado"] and (c["pct_saldo"] <= pct or (valor_min > 0 and c["saldo_atual"] <= valor_min)):
                alertas.append("saldo_acabando")
            if c["dias_para_vencer"] is not None:
                if c["dias_para_vencer"] < 0:
                    alertas.append("vencido")
                elif c["dias_para_vencer"] <= dias_alerta:
                    alertas.append("vencendo")
        c["alertas"] = alertas
        lista.append(c)
    # centros de custo e projetos de cada contrato (classe padrão + linhas), para os filtros
    cls = {}
    for r in con.execute("""SELECT x.contrato_id, bi.centro_custo, bi.projeto FROM (
                                SELECT id AS contrato_id, budget_item_id FROM nf_contratos WHERE budget_item_id IS NOT NULL
                                UNION SELECT contrato_id, budget_item_id FROM nf_contrato_itens WHERE budget_item_id IS NOT NULL) x
                            JOIN bud_itens bi ON bi.id = x.budget_item_id"""):
        d = cls.setdefault(r["contrato_id"], {"ccs": set(), "projetos": set()})
        d["ccs"].add(r["centro_custo"] or ""); d["projetos"].add(r["projeto"] or "")
    meds = {}
    for r in con.execute("""SELECT contrato_id, data_medicao, data_emissao, data_vencimento, valor FROM nf_medicoes
                            WHERE status<>'CANCELADA' AND contrato_id IS NOT NULL"""):
        meds.setdefault(r["contrato_id"], []).append([r["data_medicao"] or "", r["data_emissao"] or "", r["data_vencimento"] or "", r["valor"] or 0])
    for c in lista:
        d = cls.get(c["id"], {"ccs": set(), "projetos": set()})
        c["ccs"], c["projetos"] = sorted(d["ccs"]), sorted(d["projetos"])
        c["medicoes"] = meds.get(c["id"], [])     # [data da medição, emissão, vencimento, valor]
    return lista


def _sql_campos(sla):
    return f"""
        m.*, c.numero AS contrato, COALESCE(c.fornecedor, pd.fornecedor) AS fornecedor, c.finalizado AS contrato_finalizado,
        pd.numero AS pedido, pd.valor AS pedido_valor,
        COALESCE(ci.numero, iu.numero) AS item_numero, COALESCE(ci.descricao, iu.descricao) AS item_descricao,
        bi.id AS classe_id, bi.centro_custo AS classe_cc, bi.projeto AS classe_projeto, bi.classe_numero AS classe_numero,
        bi.classe_descricao AS classe_descricao, COALESCE(cn.n, 0) AS n_itens_contrato,
        (SELECT descricao FROM bud_centros WHERE nome = bi.centro_custo) AS classe_cc_desc,
        (SELECT group_concat(i.classe_numero || ' · CC ' || i.centro_custo || ' · ' || printf('%.2f', r.pct) || '%', ' | ')
           FROM nf_rateio r JOIN bud_itens i ON i.id = r.item_id WHERE r.medicao_id = m.id) AS rateio,
        (SELECT group_concat(i.classe_numero || ' · CC ' || i.centro_custo || ' · ' || printf('%.2f', r.pct) || '%', ' | ')
           FROM bud_pedido_rateio r JOIN bud_itens i ON i.id = r.item_id WHERE r.pedido_id = m.pedido_id) AS rateio_pedido,
        (m.anexo_arquivo<>'' OR m.caminho_externo<>'') AS tem_anexo,
        CASE WHEN m.dias_uteis IS NULL THEN NULL WHEN m.dias_uteis <= {sla} THEN 'NO PRAZO' ELSE 'ATRASADO' END AS sla_envio,
        CASE WHEN m.dias_uteis IS NULL OR m.dias_uteis <= {sla} THEN NULL
             WHEN TRIM(m.observacao)<>'' THEN 'COM' ELSE 'SEM' END AS justificativa,
        COALESCE(p.prazo, '') AS prazo_recebimento,
        CASE WHEN m.data_emissao='' THEN NULL WHEN p.prazo IS NULL THEN 'SEM PRAZO'
             WHEN m.data_emissao <= p.prazo THEN 'ATENDIDO' ELSE 'NÃO ATENDIDO' END AS sla_recebimento"""


_FROM = """ FROM nf_medicoes m
        LEFT JOIN nf_contratos c ON c.id = m.contrato_id
        LEFT JOIN nf_contrato_itens ci ON ci.id = m.contrato_item_id AND ci.contrato_id = m.contrato_id
        LEFT JOIN bud_pedidos pd ON pd.id = m.pedido_id
        LEFT JOIN (SELECT contrato_id, MIN(numero) AS numero, MIN(descricao) AS descricao FROM nf_contrato_itens
                   GROUP BY contrato_id HAVING COUNT(*) = 1) iu ON iu.contrato_id = m.contrato_id
        LEFT JOIN (SELECT contrato_id, MIN(budget_item_id) AS bid, COUNT(*) AS n FROM nf_contrato_itens GROUP BY contrato_id) cn
               ON cn.contrato_id = m.contrato_id
        LEFT JOIN bud_itens bi ON bi.id = """ + "{CLASSE}" + """
        LEFT JOIN nf_prazos p ON p.mes = substr(m.data_emissao, 1, 7) """

# classe financeira da medição (mesma regra do budget): escolhida na medição > item do contrato >
# itens do contrato todos com a mesma classe (ex.: contrato de uma linha só) > classe padrão do contrato > classe do pedido
_UNICA = """(SELECT MIN(x.budget_item_id) FROM nf_contrato_itens x WHERE x.contrato_id = m.contrato_id
             HAVING COUNT(DISTINCT x.budget_item_id) = 1 AND COUNT(x.budget_item_id) = COUNT(*))"""
CLASSE = f"COALESCE(m.budget_item_id, ci.budget_item_id, {_UNICA}, c.budget_item_id, pd.item_id)"
_FROM = _FROM.replace("{CLASSE}", CLASSE)

ORDENS = {"medicao": "m.data_medicao", "emissao": "m.data_emissao", "vencimento": "m.data_vencimento",
          "valor": "m.valor", "numero": "CAST(m.numero_medicao AS INTEGER)", "nf": "CAST(m.numero_documento AS INTEGER)",
          "fornecedor": "COALESCE(c.fornecedor, pd.fornecedor)", "dias": "m.dias_uteis", "status": "m.status", "email": "m.email_gerado_em"}


def _norm(s):
    return importer.sem_acento(s or "").lower()


# data usada no filtro de período (escolhida na tela; padrão = data da medição, a mesma do budget)
REF_DATAS = {
    "medicao": "COALESCE(NULLIF(m.data_medicao,''), m.data_emissao)",
    "emissao": "COALESCE(NULLIF(m.data_emissao,''), m.data_medicao)",
    "vencimento": "COALESCE(NULLIF(m.data_vencimento,''), m.data_emissao)",
}


def _cond_rateio(campo):
    """Centro de custo / projeto da classe da medição OU de alguma parte do rateio (da NF ou do pedido)."""
    return f"""(bi.{campo} = ? OR EXISTS (SELECT 1 FROM nf_rateio r JOIN bud_itens i ON i.id = r.item_id WHERE r.medicao_id = m.id AND i.{campo} = ?)
        OR EXISTS (SELECT 1 FROM bud_pedido_rateio r JOIN bud_itens i ON i.id = r.item_id WHERE r.pedido_id = m.pedido_id AND i.{campo} = ?))"""


def _ref(args):
    return REF_DATAS.get((args or {}).get("base") or "medicao", REF_DATAS["medicao"])


def medicoes(con, args):
    """Lista paginada + totais do filtro (tudo calculado no banco)."""
    cfg = config(con)
    sla = int(cfg_num(cfg, "sla_dias_uteis"))
    cond_v, par_v = visao.cond_medicao()
    onde, par = [cond_v], list(par_v)
    ref = _ref(args)
    ref_bud = REF_DATAS["medicao"]          # o budget conta a medição no ano da data da medição
    if args.get("de"):
        onde.append(f"{ref} >= ?"); par.append(args["de"])
    if args.get("ate"):
        onde.append(f"{ref} <= ?"); par.append(args["ate"])
    if args.get("status") in STATUS:
        onde.append("m.status = ?"); par.append(args["status"])
    if args.get("contrato"):
        onde.append("m.contrato_id = ?"); par.append(int(args["contrato"]))
    if args.get("sla") == "NO PRAZO":
        onde.append(f"m.dias_uteis <= {sla}")
    elif args.get("sla") == "ATRASADO":
        onde.append(f"m.dias_uteis > {sla}")
    elif args.get("sla") == "SEM":
        onde.append(f"m.dias_uteis > {sla} AND TRIM(m.observacao)=''")
    if args.get("classe") == "sem":
        onde.append("bi.id IS NULL AND m.status<>'CANCELADA'")
    elif args.get("classe") == "fora":   # tem classe, mas a linha não está no budget do ano (o valor não é calculado)
        onde.append(f"""bi.id IS NOT NULL AND m.status<>'CANCELADA' AND m.pedido_id IS NULL AND {ref_bud}<>''
            AND NOT EXISTS (SELECT 1 FROM bud_previsto bp WHERE bp.item_id = bi.id AND bp.ano = CAST(substr({ref_bud},1,4) AS INTEGER))""")
    if args.get("cc"):
        onde.append(_cond_rateio("centro_custo")); par += [args["cc"]] * 3
    if args.get("projeto"):
        onde.append(_cond_rateio("projeto")); par += [args["projeto"]] * 3
    if args.get("email") == "pendente":
        onde.append("m.status='PROSSEGUIU' AND m.email_gerado_em=''")
    q = (args.get("q") or "").strip()
    if q:
        for palavra in _norm(q).split():
            onde.append("m.busca LIKE ?"); par.append(f"%{palavra}%")
    where = " WHERE " + " AND ".join(onde)

    k = con.execute(f"""SELECT COUNT(*) AS n,
            SUM(m.status='CANCELADA') AS canceladas,
            COALESCE(SUM(CASE WHEN m.status<>'CANCELADA' THEN m.valor END),0) AS valor,
            SUM(m.status<>'CANCELADA' AND m.dias_uteis IS NOT NULL) AS com_sla,
            SUM(m.status<>'CANCELADA' AND m.dias_uteis <= {sla}) AS no_prazo,
            SUM(m.status<>'CANCELADA' AND m.dias_uteis > {sla} AND TRIM(m.observacao)='') AS sem_just
        {_FROM}{where}""", par).fetchone()
    # aviso de medições sem classe: só as do período escolhido
    per, ppar = [], []
    if args.get("de"):
        per.append(f"{ref} >= ?"); ppar.append(args["de"])
    if args.get("ate"):
        per.append(f"{ref} <= ?"); ppar.append(args["ate"])
    sc = con.execute(f"""SELECT COUNT(*) AS n, SUM(COALESCE(cn.n,0) > 1) AS multi, COALESCE(SUM(m.valor),0) AS valor
        {_FROM} WHERE bi.id IS NULL AND m.status<>'CANCELADA' AND {cond_v} {''.join(' AND ' + x for x in per)}""", [*par_v, *ppar]).fetchone()
    kpis = {x: (k[x] or 0) for x in k.keys()}

    ordem = ORDENS.get(args.get("ordem"), "m.data_medicao")
    direcao = "ASC" if args.get("dir") == "asc" else "DESC"
    por = min(max(int(args.get("por") or 100), 10), 2000)
    paginas = max(1, -(-kpis["n"] // por))
    pagina = min(max(int(args.get("pagina") or 1), 1), paginas)
    itens = [dict(r) for r in con.execute(
        f"SELECT {_sql_campos(sla)} {_FROM}{where} ORDER BY {ordem} {direcao}, m.id DESC LIMIT ? OFFSET ?",
        (*par, por, (pagina - 1) * por))]
    pend = con.execute(f"SELECT COUNT(*) {_FROM} WHERE m.status='PROSSEGUIU' AND m.email_gerado_em='' AND {cond_v}", par_v).fetchone()[0]
    return {"itens": itens, "total": kpis["n"], "pagina": pagina, "paginas": paginas, "por": por, "kpis": kpis,
            "pendentes_email": pend, "sem_classe": {"n": sc["n"] or 0, "multi": sc["multi"] or 0, "valor": sc["valor"] or 0}}


def medicao(con, mid):
    sla = int(cfg_num(config(con), "sla_dias_uteis"))
    visao.exigir_medicao(con, mid)
    r = con.execute(f"SELECT {_sql_campos(sla)} {_FROM} WHERE m.id=?", (mid,)).fetchone()
    if not r:
        abort(404)
    return dict(r)


def graficos(con, args):
    """Números dos gráficos, somados no banco."""
    sla = int(cfg_num(config(con), "sla_dias_uteis"))
    ref = _ref(args)
    cond_v, par_v = visao.cond_medicao()
    onde, par = ["m.status<>'CANCELADA'", cond_v], list(par_v)
    if args.get("ano"):
        onde.append(f"substr({ref},1,4) = ?"); par.append(args["ano"])
    if args.get("fornecedor"):
        onde.append("COALESCE(c.fornecedor, pd.fornecedor) = ?"); par.append(args["fornecedor"])
    if args.get("de"):
        onde.append(f"{ref} >= ?"); par.append(args["de"])
    if args.get("ate"):
        onde.append(f"{ref} <= ?"); par.append(args["ate"])
    if args.get("cc"):
        onde.append(_cond_rateio("centro_custo")); par += [args["cc"]] * 3
    if args.get("projeto"):
        onde.append(_cond_rateio("projeto")); par += [args["projeto"]] * 3
    where = " WHERE " + " AND ".join(onde)
    por_mes = [dict(r) for r in con.execute(f"""
        SELECT substr({ref},1,7) AS mes, COUNT(*) AS n, SUM(m.valor) AS valor,
               SUM(m.dias_uteis <= {sla}) AS no_prazo, SUM(m.dias_uteis > {sla}) AS atrasada,
               SUM(m.dias_uteis IS NULL) AS sem_data
        {_FROM}{where} AND {ref}<>'' GROUP BY 1 ORDER BY 1""", par)]
    t = con.execute(f"""
        SELECT COUNT(*) AS n, COALESCE(SUM(m.valor),0) AS valor,
               SUM(m.dias_uteis <= {sla}) AS no_prazo, SUM(m.dias_uteis > {sla}) AS atrasada,
               SUM(m.dias_uteis > {sla} AND TRIM(m.observacao)<>'') AS com,
               SUM(m.dias_uteis > {sla} AND TRIM(m.observacao)='') AS sem,
               SUM(m.data_emissao<>'' AND p.prazo IS NULL) AS sem_prazo
        {_FROM}{where}""", par).fetchone()
    forn = [dict(r) for r in con.execute(f"""
        SELECT COALESCE(c.fornecedor, pd.fornecedor) AS f, SUM(m.data_emissao <= p.prazo) AS ok, SUM(m.data_emissao > p.prazo) AS fora
        {_FROM}{where} AND p.prazo IS NOT NULL AND m.data_emissao<>'' GROUP BY 1
        ORDER BY (ok + fora) DESC""", par)]
    # NFs de cada mês de emissão que chegaram até a data limite do mês (tela Prazos e feriados)
    prazo_mes = {r["mes"]: dict(r) for r in con.execute(f"""
        SELECT substr(m.data_emissao,1,7) AS mes, COUNT(*) AS n, SUM(m.data_emissao <= p.prazo) AS ok
        {_FROM}{where} AND m.data_emissao<>'' GROUP BY 1""", par)}
    if visao.atual() is None:
        anos = [r[0] for r in con.execute(f"SELECT DISTINCT substr({ref},1,4) FROM nf_medicoes m WHERE {ref}<>'' ORDER BY 1 DESC")]
        fornecedores = [r[0] for r in con.execute("SELECT fornecedor FROM nf_contratos UNION SELECT fornecedor FROM bud_pedidos "
                                                  "WHERE id IN (SELECT pedido_id FROM nf_medicoes) ORDER BY 1") if r[0]]
    else:   # visão restrita: só os anos e fornecedores do que a pessoa vê
        anos = [r[0] for r in con.execute(f"SELECT DISTINCT substr({ref},1,4) {_FROM} WHERE {ref}<>'' AND {cond_v} ORDER BY 1 DESC", par_v)]
        fornecedores = [r[0] for r in con.execute(f"SELECT DISTINCT COALESCE(c.fornecedor, pd.fornecedor) {_FROM} WHERE {cond_v} ORDER BY 1", par_v) if r[0]]
    return {"por_mes": por_mes, "prazo_mes": prazo_mes, "totais": {x: (t[x] or 0) for x in t.keys()}, "fornecedores_prazo": forn,
            "anos": anos, "fornecedores": fornecedores, "sla_dias": sla}


# ----------------------------------------------------------------------------- e-mails (.eml)
def _saudacao(hora, variante=1):
    p = "Bom dia" if hora < 12 else "Boa tarde" if hora < 18 else "Boa noite"
    return f"{p}, como vão, prezados?" if variante == 1 else f"{p}, prezados. Como vão?"


def _lista_emails(txt):
    """'a@x.com; b@y.com' -> 'a@x.com, b@y.com' (formato do cabeçalho de e-mail)."""
    partes = [p.strip() for p in (txt or "").replace(",", ";").split(";") if p.strip()]
    return ", ".join(partes)


def _html_email(corpo):
    return ('<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>'
            f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1F1F1F;">{corpo}</div></body></html>')


def _eml(assunto, html, texto, para="", cc="", cco="", anexo=None):
    """Mensagem 'não enviada': o novo Outlook abre para editar e enviar, com o anexo, se X-Unsent for a 1ª linha e houver Message-ID.
    Texto e HTML juntos (multipart/alternative) foi a montagem aprovada no teste com o novo Outlook."""
    msg = EmailMessage()
    msg["X-Unsent"] = "1"
    msg["Message-ID"] = make_msgid(domain="central-engenharia.local")
    msg["Subject"] = assunto
    msg["Date"] = formatdate(localtime=True)
    for cab, v in (("To", para), ("Cc", cc), ("Bcc", cco)):
        v = _lista_emails(v)
        if v:
            msg[cab] = v
    # base64 (e não quoted-printable): o Outlook mostrava "=" e "=A7" no lugar dos acentos e das quebras de linha
    msg.set_content(texto, charset="utf-8", cte="base64")
    msg.add_alternative(_html_email(html), subtype="html", charset="utf-8", cte="base64")
    if anexo:
        nome, dados = anexo
        tipo = mimetypes.guess_type(nome)[0] or "application/octet-stream"
        principal, sub = tipo.split("/", 1)
        msg.add_attachment(dados, maintype=principal, subtype=sub, filename=nome)
    return BytesIO(msg.as_bytes(policy=email.policy.SMTP))   # quebras de linha CRLF, como o Outlook espera


def _br(iso):
    d = _d(iso)
    return d.strftime("%d/%m/%Y") if d else ""


def _arquivo_anexo(m):
    """(nome, caminho) do anexo da medição: arquivo enviado ao site ou o caminho antigo da planilha."""
    if m["anexo_arquivo"]:
        p = db.NF_DIR / m["anexo_arquivo"]
        if p.exists():
            return m["anexo_nome"] or p.name, p
    p = seguranca.arquivo_externo(m["caminho_externo"])
    return (p.name, p) if p else (None, None)


def _dados_email(assunto, texto, para, cc, cco, com_anexo=False):
    """Só para mostrar na janela e abrir sem o arquivo: destinatários, assunto e texto."""
    return {"assunto": assunto, "texto": texto, "para": _lista_emails(para), "cc": _lista_emails(cc), "cco": _lista_emails(cco), "com_anexo": com_anexo}


def email_medicao(m, hora, cfg, so_dados=False):
    venc = _d(m["data_vencimento"])
    dias = int(cfg_num(cfg, "dias_liberacao"))
    liberar = (venc - dt.timedelta(days=dias)).strftime("%d/%m/%Y") if venc else "[sem data de vencimento]"
    nf, med, forn, contr = m["numero_documento"], m["numero_medicao"], m["fornecedor"], m["contrato"]
    rotulo_contr = "Contrato"
    if not contr and m["pedido"]:
        rotulo_contr, contr = "Pedido de compra", m["pedido"]
    ref = f"Medição {med}" if med else f"{rotulo_contr} {contr}"
    assunto = f"NF {nf} - {forn} | {ref}"
    html = (
        f"<p>{_saudacao(hora)}</p>"
        f"<p>Segue Nota Fiscal <b>{escape(str(nf))}</b> referente {'à' if med else 'ao'} <b>{escape(ref)}</b>.</p>"
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:16px 0;"><tr>'
        '<td style="background-color:#F6EFFC;border-left:4px solid #8D0DE3;padding:12px 16px;">'
        f'<p style="margin:4px 0;"><b>Fornecedor:</b> {escape(str(forn))}</p>'
        f'<p style="margin:4px 0;"><b>{rotulo_contr}:</b> {escape(str(contr))}</p>'
        "</td></tr></table>"
        f'<p style="color:#C62828;"><b>Por favor, liberar para o visualização do financeiro até {liberar}</b>.</p>'
        "<p>Documento disponível em anexo para processamento.</p>")
    texto = (f"{_saudacao(hora)}\n\nSegue Nota Fiscal {nf} referente {'à' if med else 'ao'} {ref}.\n\n"
             f"Fornecedor: {forn}\n{rotulo_contr}: {contr}\n\n"
             f"Por favor, liberar para o visualização do financeiro até {liberar}.\n\n"
             "Documento disponível em anexo para processamento.\n")
    nome, caminho = _arquivo_anexo(m)
    if so_dados:
        return _dados_email(assunto, texto, cfg["email_nf_para"], cfg["email_nf_cc"], cfg["email_nf_cco"], bool(caminho))
    anexo = (nome, caminho.read_bytes()) if caminho else None
    return assunto, _eml(assunto, html, texto, cfg["email_nf_para"], cfg["email_nf_cc"], cfg["email_nf_cco"], anexo), bool(anexo)


def email_prazo(mes, prazo, hora, cfg, so_dados=False):
    a, mm = mes.split("-")
    nome_mes = MESES[int(mm) - 1]
    assunto = f"Prazo para Recebimento de Notas Fiscais - {nome_mes}"
    p = _br(prazo)
    html = (
        f"<p>{_saudacao(hora, 2)}</p>"
        f"<p>Gostaríamos de informar que o prazo limite para o recebimento das notas fiscais referentes ao mês de <b>{nome_mes}</b> é até o dia <b>{p}</b>.</p>"
        "<p>Solicitamos gentilmente que o envio seja realizado dentro deste prazo estipulado. O cumprimento desta data é fundamental para garantirmos o nosso fluxo de processamento interno e os pagamentos nos prazos corretos.</p>"
        "<p>Caso a nota fiscal já tenha sido enviada, por gentileza, desconsiderar o lembrete.</p>"
        "<p>Contamos com a colaboração de todos e ficamos à disposição em caso de dúvidas.</p>")
    texto = (f"{_saudacao(hora, 2)}\n\nGostaríamos de informar que o prazo limite para o recebimento das notas fiscais "
             f"referentes ao mês de {nome_mes} é até o dia {p}.\n\n"
             "Solicitamos gentilmente que o envio seja realizado dentro deste prazo estipulado. O cumprimento desta data é "
             "fundamental para garantirmos o nosso fluxo de processamento interno e os pagamentos nos prazos corretos.\n\n"
             "Caso a nota fiscal já tenha sido enviada, por gentileza, desconsiderar o lembrete.\n\n"
             "Contamos com a colaboração de todos e ficamos à disposição em caso de dúvidas.\n")
    if so_dados:
        return _dados_email(assunto, texto, cfg["email_forn_para"], cfg["email_forn_cc"], cfg["email_forn_cco"])
    return assunto, _eml(assunto, html, texto, cfg["email_forn_para"], cfg["email_forn_cc"], cfg["email_forn_cco"])


def _nome_arquivo(t):
    return "".join(ch for ch in t if ch not in '\\/:*?"<>|').strip()[:150] + ".eml"


# ----------------------------------------------------------------------------- importação da planilha
def importar_planilha(caminho):
    """Lê a planilha EnviarEmailNF (abas Cadastro, CONTRATOS, DADOS, PRAZO RECEBIMENTO NFS, FERIADOS).

    - Medição nova (nº da medição + nº da NF ainda não cadastrados) -> entra.
    - Medição que já existe -> só completa campos que estão VAZIOS no site (datas, valor, observação,
      caminho da NF, contrato). O que já foi preenchido/editado no site não é alterado nem duplicado.
    - Contratos: novos entram; existentes só têm campos vazios completados (datas, saldo, aditivo).
    - Prazos de recebimento e feriados: só os que faltam.
    Devolve um resumo com o que entrou, o que foi completado e as linhas ignoradas (com o motivo)."""
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(caminho))
    abas = {importer.sem_acento(n).upper().strip(): n for n in wb.sheet_names}

    def tabela(nome, exato=False):
        n = next((v for k, v in abas.items() if (k == nome if exato else nome in k)), None)
        if not n:
            return []
        d = wb.get_sheet_by_name(n).to_python()
        for i, r in enumerate(d[:6]):
            if any(importer.sem_acento(importer.up(x)) in ("CONTRATO", "MEDICAO", "MES", "FORNECEDOR") for x in r):
                cab = [importer.sem_acento(importer.up(x)) for x in r]
                # "NÃO ESTÁ NAS LISTAS" (fórmula da planilha de importação) conta como vazio
                return [(i + k + 2, dict(zip(cab, ["" if isinstance(y, str) and y.startswith(importer.AVISOS_LISTA) else y for y in x])))
                        for k, x in enumerate(d[i + 1:]) if any(importer.txt(y) for y in x)]
        return [(k + 1, {"_": r[0]}) for k, r in enumerate(d) if r and importer.txt(r[0])]   # aba sem cabeçalho (FERIADOS)

    res = {"contratos": 0, "contratos_completados": 0, "medicoes": 0, "medicoes_completadas": 0, "ja_existiam": 0,
           "prazos": 0, "feriados": 0, "ignoradas": 0, "avisos": [], "novas": [],
           "classe_auto": 0, "classe_planilha": 0, "sem_classe": []}
    norm = lambda t: importer.sem_acento(importer.up(t))
    with db.connect() as con:
        contratos = {r["numero"]: dict(r) for r in con.execute("SELECT * FROM nf_contratos")}
        # aba Cadastro: fornecedor -> contrato (usada quando a coluna CONTRATO da linha está vazia)
        forn_contrato = {norm(r.get("FORNECEDOR")): _num_txt(r.get("CONTRATO"))
                         for _, r in tabela("CADASTRO", exato=True) if importer.txt(r.get("FORNECEDOR")) and importer.txt(r.get("CONTRATO"))}

        def contrato_id(numero, fornecedor="", **extra):
            numero = _num_txt(numero)
            if not numero:
                return None
            c = contratos.get(numero)
            if not c:
                cid = con.execute(
                    "INSERT INTO nf_contratos(numero, fornecedor, data_inicio, data_fim, saldo_contratado, aditivo, finalizado) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (numero, importer.up(fornecedor) or "SEM FORNECEDOR", extra.get("ini", ""), extra.get("fim", ""),
                     extra.get("saldo", 0), extra.get("aditivo", 0), extra.get("fin", 0))).lastrowid
                contratos[numero] = {"id": cid, "numero": numero, "fornecedor": importer.up(fornecedor) or "SEM FORNECEDOR",
                                     "data_inicio": extra.get("ini", ""), "data_fim": extra.get("fim", ""),
                                     "saldo_contratado": extra.get("saldo", 0), "aditivo": extra.get("aditivo", 0), "_novo": True}
                res["contratos"] += 1
            elif extra and not c.get("_novo"):
                # completa só o que está vazio no site
                mud = {}
                for campo, chave in (("data_inicio", "ini"), ("data_fim", "fim"), ("saldo_contratado", "saldo"), ("aditivo", "aditivo")):
                    if not c.get(campo) and extra.get(chave):
                        mud[campo] = extra[chave]
                if (c.get("fornecedor") in ("", "SEM FORNECEDOR")) and fornecedor:
                    mud["fornecedor"] = importer.up(fornecedor)
                if mud:
                    con.execute(f"UPDATE nf_contratos SET {', '.join(k + '=?' for k in mud)} WHERE id=?", (*mud.values(), c["id"]))
                    c.update(mud)
                    res["contratos_completados"] += 1
            return contratos[numero]["id"]

        for _, r in tabela("CONTRATOS"):
            if not importer.txt(r.get("CONTRATO")):
                continue
            fin = r.get("FINALIZADO")
            contrato_id(r["CONTRATO"], r.get("FORNECEDOR"), ini=importer.data_iso(r.get("DATA INICIO")) or "",
                        fim=importer.data_iso(r.get("DATA FINAL")) or "", saldo=importer.num(r.get("SALDO CONTRATADO")),
                        aditivo=importer.num(r.get("ADITIVO")),
                        fin=1 if fin is True or importer.up(fin) in ("SIM", "TRUE", "VERDADEIRO", "1") else 0)

        # aba ITENS CONTRATO (opcional): itens/linhas de cada contrato com centro de custo, projeto e classe do budget
        itens_ct = {}
        for r in con.execute("SELECT * FROM nf_contrato_itens"):
            itens_ct.setdefault((r["contrato_id"], r["numero"]), dict(r))
        res["itens_contrato"] = 0
        linhas_itens = tabela("ITENS CONTRATO")
        if linhas_itens:
            import budget
            for linha, r in linhas_itens:
                num_c = _num_txt(r.get("CONTRATO"))
                c = contratos.get(num_c)
                item_num, desc = _num_txt(r.get("ITEM")), importer.txt(r.get("DESCRICAO"))
                if not num_c or not (item_num or desc):
                    continue
                if not c:
                    res["avisos"].append(f"ITENS CONTRATO linha {linha}: contrato {num_c} não existe (cadastre o contrato antes).")
                    continue
                classe = budget._txt(r.get("CLASSE FINANCEIRA"))
                cc = r.get("CENTRO DE CUSTO (Nº)", r.get("CENTRO DE CUSTO"))
                pj = r.get("PROJETO (Nº)", r.get("PROJETO"))
                classe = classe or budget._txt(r.get("CLASSE FINANCEIRA (Nº)"))
                bid = budget.item_id(con, cc, pj, classe) if classe else None
                atual = itens_ct.get((c["id"], item_num))
                if atual:
                    mud = {k: v for k, v in (("descricao", desc), ("budget_item_id", bid)) if v and not atual.get(k)}
                    if mud:
                        con.execute(f"UPDATE nf_contrato_itens SET {', '.join(k + '=?' for k in mud)} WHERE id=?", (*mud.values(), atual["id"]))
                        res["itens_contrato"] += 1
                    continue
                iid = con.execute("INSERT INTO nf_contrato_itens(contrato_id, numero, descricao, budget_item_id, ordem) VALUES (?,?,?,?,?)",
                                  (c["id"], item_num, desc, bid, len([k for k in itens_ct if k[0] == c["id"]]))).lastrowid
                itens_ct[(c["id"], item_num)] = {"id": iid, "contrato_id": c["id"], "numero": item_num, "descricao": desc, "budget_item_id": bid}
                res["itens_contrato"] += 1

        existentes = {}
        for r in con.execute("SELECT * FROM nf_medicoes"):
            existentes.setdefault((r["numero_medicao"], r["numero_documento"]), dict(r))
        # fornecedor com um único contrato no site: a linha sem CONTRATO usa esse contrato
        por_forn = {}
        for c in contratos.values():
            por_forn.setdefault(norm(c["fornecedor"]), []).append(c["numero"])
        pedidos = {r["numero"]: dict(r) for r in con.execute("SELECT id, numero, fornecedor FROM bud_pedidos")}
        import budget
        # classe padrão do contrato (vale para todas as medições dele)
        contratos_cls = {r[0]: r[1] for r in con.execute("SELECT id, budget_item_id FROM nf_contratos WHERE budget_item_id IS NOT NULL")}
        mexidas = []
        for linha, r in tabela("DADOS"):
            med, nf = _num_txt(r.get("MEDICAO")), _num_txt(r.get("NF"))
            num_pedido = _num_txt(r.get("PEDIDO") or r.get("PEDIDO DE COMPRA") or r.get("PC"))
            numero_contrato = r.get("CONTRATO") if importer.txt(r.get("CONTRATO")) else forn_contrato.get(norm(r.get("FORNECEDOR")))
            if not numero_contrato and not num_pedido and len(por_forn.get(norm(r.get("FORNECEDOR")), [])) == 1:
                numero_contrato = por_forn[norm(r.get("FORNECEDOR"))][0]
            if not (med or nf):
                res["ignoradas"] += 1
                res["avisos"].append(f"Linha {linha}: sem nº de medição e sem nº de NF ({importer.txt(r.get('FORNECEDOR')) or 'sem fornecedor'}).")
                continue
            pid = None
            if num_pedido and not importer.txt(r.get("CONTRATO")):
                ped = pedidos.get(num_pedido)
                if not ped:   # pedido ainda não cadastrado: entra com o fornecedor da linha
                    forn_p = importer.up(r.get("FORNECEDOR"))
                    pid_novo = con.execute("INSERT INTO bud_pedidos(numero, fornecedor) VALUES (?,?)", (num_pedido, forn_p)).lastrowid
                    ped = pedidos[num_pedido] = {"id": pid_novo, "numero": num_pedido, "fornecedor": forn_p}
                    res["avisos"].append(f"Linha {linha}: pedido {num_pedido} não existia — cadastrado só com o fornecedor (complete em Notas fiscais › Pedidos de compra).")
                pid = ped["id"]
            cid = None if pid else contrato_id(numero_contrato, r.get("FORNECEDOR"))
            if not cid and not pid:
                res["ignoradas"] += 1
                res["avisos"].append(f"Linha {linha}: medição {med or '—'} / NF {nf or '—'} sem contrato nem pedido (fornecedor “{importer.txt(r.get('FORNECEDOR'))}”).")
                continue
            st = importer.up(r.get("STATUS"))
            obs = importer.txt(r.get("OBS"))
            if st.startswith("ENVIAD") or not st:
                status = "PROSSEGUIU"
            elif st.startswith("CANCEL"):
                status = "CANCELADA"
            else:
                status = "PENDENTE"
                obs = (obs + " · " if obs else "") + st.capitalize()
            dados = {
                "data_emissao": importer.data_iso(r.get("DATA EMISSAO")) or "",
                "data_vencimento": importer.data_iso(r.get("DATA VENCIMENTO")) or "",
                "data_medicao": importer.data_iso(r.get("DATA MEDICAO")) or "",
                "valor": importer.num(r.get("VALOR")),
                "caminho_externo": importer.txt(r.get("CAMINHO NF")),
                "observacao": obs,
                "contrato_id": cid,
                "pedido_id": pid,
            }
            item_num = _num_txt(r.get("ITEM"))
            if item_num and cid:
                it = itens_ct.get((cid, item_num))
                if it:
                    dados["contrato_item_id"] = it["id"]
                else:
                    res["avisos"].append(f"Linha {linha}: item {item_num} não está cadastrado no contrato (aba ITENS CONTRATO) — a medição entrou sem item.")
            # classe financeira: contrato com uma linha só -> usa essa linha; classe digitada na planilha -> usa a digitada;
            # contrato sem linha ou com várias -> entra sem classe e vai para a lista de avisos (completar à mão)
            if cid and not dados.get("contrato_item_id"):
                linhas_ct = [v for k, v in itens_ct.items() if k[0] == cid]
                classe_pl = budget._txt(r.get("CLASSE FINANCEIRA (Nº)") or r.get("CLASSE FINANCEIRA"))
                atual_m = existentes.get((med, nf)) or {}
                if classe_pl:
                    dados["budget_item_id"] = budget.item_id(con, r.get("CENTRO DE CUSTO (Nº)"), r.get("PROJETO (Nº)"), classe_pl)
                    res["classe_planilha"] += 1
                elif linhas_ct and len({l.get("budget_item_id") for l in linhas_ct}) == 1 and linhas_ct[0].get("budget_item_id"):
                    if len(linhas_ct) == 1:          # uma linha só: a medição fica ligada a ela
                        dados["contrato_item_id"] = linhas_ct[0]["id"]
                    res["classe_auto"] += 1          # várias linhas com a mesma classe: o site já resolve sozinho
                elif not (atual_m.get("contrato_item_id") or atual_m.get("budget_item_id")) and not contratos_cls.get(cid):
                    num_ct = next((c["numero"] for c in contratos.values() if c["id"] == cid), "")
                    motivo = (f"o contrato {num_ct} tem {len(linhas_ct)} linhas: informe o ITEM ou a CLASSE FINANCEIRA" if len(linhas_ct) > 1
                              else f"o contrato {num_ct} não tem linha com classe cadastrada: cadastre em Contratos ou informe a CLASSE FINANCEIRA")
                    res["sem_classe"].append(f"Linha {linha}: medição {med or '—'} / NF {nf or '—'} — {motivo}.")
            atual = existentes.get((med, nf))
            if atual and cid and atual.get("contrato_id") and atual["contrato_id"] != cid and dados.get("contrato_item_id"):
                # a planilha diz que a medição é de outro contrato e informa a linha dele: a medição muda de contrato
                num_novo = next((c["numero"] for c in contratos.values() if c["id"] == cid), "")
                num_velho = next((c["numero"] for c in contratos.values() if c["id"] == atual["contrato_id"]), "")
                con.execute("UPDATE nf_medicoes SET contrato_id=?, contrato_item_id=?, budget_item_id=NULL WHERE id=?",
                            (cid, dados["contrato_item_id"], atual["id"]))
                res["avisos"].append(f"Linha {linha}: medição {med or '—'} passou do contrato {num_velho} para o {num_novo}, como está na planilha.")
                atual.update(contrato_id=cid, contrato_item_id=dados["contrato_item_id"])
                mexidas.append(atual["id"])
            if atual:
                if atual.get("contrato_id") and atual["contrato_id"] != cid:   # item de outro contrato não serve para esta medição
                    dados.pop("contrato_item_id", None)
                mud = {k: v for k, v in dados.items() if v and not atual.get(k)}
                if mud:
                    con.execute(f"UPDATE nf_medicoes SET {', '.join(k + '=?' for k in mud)} WHERE id=?", (*mud.values(), atual["id"]))
                    atual.update(mud)
                    mexidas.append(atual["id"])
                    res["medicoes_completadas"] += 1
                else:
                    res["ja_existiam"] += 1
                continue
            mid = con.execute(
                "INSERT INTO nf_medicoes(numero_medicao, numero_documento, data_emissao, data_vencimento, data_medicao, valor, "
                "contrato_id, caminho_externo, observacao, status, email_gerado_em, contrato_item_id, pedido_id, budget_item_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (med, nf, dados["data_emissao"], dados["data_vencimento"], dados["data_medicao"], dados["valor"], cid,
                 dados["caminho_externo"], obs, status, "planilha" if st.startswith("ENVIAD") else "", dados.get("contrato_item_id"), pid,
                 dados.get("budget_item_id"))).lastrowid
            existentes[(med, nf)] = {"id": mid, **dados, "numero_medicao": med, "numero_documento": nf}
            mexidas.append(mid)
            res["medicoes"] += 1
            if len(res["novas"]) < 15:
                forn = next((c["fornecedor"] for c in contratos.values() if c["id"] == cid), "") if cid else (ped["fornecedor"] + f" (pedido {num_pedido})")
                brl = f"R$ {dados['valor']:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
                res["novas"].append(f"Medição {med or '—'} · NF {nf or '—'} · {forn} · {brl}")

        for _, r in tabela("PRAZO"):
            mes, prazo = importer.data_iso(r.get("MES")), importer.data_iso(r.get("PRAZO"))
            if not mes:   # mês digitado como texto: 11/2026, 2026-11, 11-2026
                m = re.match(r"^\s*(\d{1,2})[/-](\d{4})\s*$", importer.txt(r.get("MES"))) or None
                m2 = re.match(r"^\s*(\d{4})[/-](\d{1,2})\s*$", importer.txt(r.get("MES"))) or None
                mes = f"{m.group(2)}-{int(m.group(1)):02d}-01" if m else (f"{m2.group(1)}-{int(m2.group(2)):02d}-01" if m2 else "")
            if mes and prazo:
                res["prazos"] += con.execute("INSERT OR IGNORE INTO nf_prazos(mes, prazo, email_gerado_em) VALUES (?,?,?)",
                                             (mes[:7], prazo, "planilha" if importer.up(r.get("STATUS")) else "")).rowcount
        fer_novos = 0
        for _, r in tabela("FERIADOS"):
            d = importer.data_iso(r.get("_") or r.get("DATA") or "")
            if d:
                fer_novos += con.execute("INSERT OR IGNORE INTO nf_feriados(data) VALUES (?)", (d,)).rowcount
        res["feriados"] = fer_novos
        muitas = len(mexidas) > 500                     # muitas linhas: recalcula tudo de uma vez
        if fer_novos or muitas:
            recalcular_dias_uteis(con)                  # feriado novo muda os dias úteis de todas
        elif mexidas:
            recalcular_dias_uteis(con, ids=mexidas)
        if muitas:
            atualizar_busca(con)
        elif mexidas:
            atualizar_busca(con, ids=mexidas)
        con.commit()
    return res


def _meses_entre(ini, fim):
    a, m = int(ini[:4]), int(ini[5:7])
    out = []
    while f"{a:04d}-{m:02d}" <= fim[:7] and len(out) < 120:
        out.append(f"{a:04d}-{m:02d}")
        m += 1
        if m == 13:
            a, m = a + 1, 1
    return out


def _aba_contratos_mes(wb, con, args):
    """Aba 'CONTRATOS MÊS A MÊS' (como a visão do budget): por contrato + classe financeira, valor inicial do contrato,
    saldo atual, medido total, medido em cada mês do período e média por mês (só os meses que tiveram medição)."""
    import budget
    import exporter
    a = args or {}
    hoje = dt.date.today()
    de, ate = a.get("de") or "", a.get("ate") or ""
    if not de and not ate:
        de, ate = f"{hoje.year}-01-01", f"{hoje.year}-12-31"
    elif not de:
        de = f"{ate[:4]}-01-01"
    elif not ate:
        ate = hoje.isoformat() if de <= hoje.isoformat() else de
    meses = _meses_entre(de, ate)
    ref = _ref(a).replace("m.", "m.")
    cs = {c["id"]: c for c in contratos(con)}
    itens = {r["id"]: dict(r) for r in con.execute("""
        SELECT bi.*, COALESCE(bc.descricao,'') AS cc_desc, COALESCE(bp.descricao,'') AS pj_desc
        FROM bud_itens bi LEFT JOIN bud_centros bc ON bc.nome = bi.centro_custo LEFT JOIN bud_projetos bp ON bp.nome = bi.projeto""")}
    linhas_c = {}
    for r in con.execute("""SELECT id AS cid, budget_item_id AS bid FROM nf_contratos WHERE budget_item_id IS NOT NULL
                            UNION SELECT contrato_id, budget_item_id FROM nf_contrato_itens WHERE budget_item_id IS NOT NULL"""):
        linhas_c.setdefault(r["cid"], set()).add(r["bid"])
    med = {}   # (contrato, chave da classe) -> {"total": x, "meses": {mes: valor}}
    for r in con.execute(f"""SELECT m.contrato_id AS cid, {budget.ITEM_MED} AS bid, {ref} AS data, {budget.VAL_MED} AS valor
                             {budget.FROM_MED} WHERE m.status <> 'CANCELADA' AND m.contrato_id IS NOT NULL"""):
        i = itens.get(r["bid"]) or {}
        k = (i.get("centro_custo", ""), i.get("projeto", ""), i.get("classe_numero", ""))
        v = med.setdefault((r["cid"], k), {"total": 0.0, "meses": {}, "item": i})
        v["total"] += r["valor"] or 0
        mes = (r["data"] or "")[:7]
        if mes in meses:
            v["meses"][mes] = v["meses"].get(mes, 0) + (r["valor"] or 0)
    linhas = []
    for cid, c in sorted(cs.items(), key=lambda x: (x[1]["finalizado"], x[1]["fornecedor"])):
        chaves = {}
        for bid in linhas_c.get(cid, set()):
            i = itens.get(bid) or {}
            chaves.setdefault((i.get("centro_custo", ""), i.get("projeto", ""), i.get("classe_numero", "")), i)
        for (ccid, k), v in med.items():
            if ccid == cid:
                chaves.setdefault(k, v["item"])
        if not chaves:
            chaves[("", "", "")] = {}
        no_periodo = any(med.get((cid, k), {}).get("meses") for k in chaves)
        if c["finalizado"] and not no_periodo:
            continue                      # contrato finalizado sem medição no período: fica de fora
        for n, (k, i) in enumerate(sorted(chaves.items())):
            if a.get("cc") and k[0] != a["cc"] or a.get("projeto") and k[1] != a["projeto"]:
                continue
            v = med.get((cid, k), {"total": 0.0, "meses": {}})
            por_mes = [round(v["meses"].get(m, 0), 2) or None for m in meses]
            com_med = [x for x in por_mes if x]
            primeira = n == 0
            from openpyxl.utils import get_column_letter as _L
            r = 5 + len(linhas)                      # linha no Excel (cabeçalho na 4)
            m1, m2 = _L(18), _L(17 + len(meses))     # colunas dos meses
            sp, sq = _L(18 + len(meses)), _L(19 + len(meses))
            linhas.append([
                int(c["numero"]) if str(c["numero"]).isdigit() else c["numero"], c["fornecedor"],
                "Finalizado" if c["finalizado"] else "Ativo", _d(c["data_inicio"]), _d(c["data_fim"]),
                k[2] or None, i.get("classe_descricao") or None, k[0] or None, i.get("cc_desc") or None, k[1] or None, i.get("pj_desc") or None,
                c["saldo_contratado"] if primeira else None, (c["aditivo"] or None) if primeira else None,
                f"=N(L{r})+N(M{r})" if primeira else None,
                round(v["total"], 2),
                # saldo e % do contrato inteiro (todas as linhas / classes dele): contratado − medido
                f"=N{r}-SUMIFS($O:$O,$A:$A,$A{r})" if primeira else None,
                f'=IFERROR(SUMIFS($O:$O,$A:$A,$A{r})/N{r},"")' if primeira else None,
                *por_mes,
                f"=SUM({m1}{r}:{m2}{r})", f"=COUNT({m1}{r}:{m2}{r})", f'=IFERROR({sp}{r}/{sq}{r},"")',
            ])
    nomes = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]
    rot = lambda m: f"{nomes[int(m[5:7]) - 1]}/{m[2:4]}"
    cab = ["CONTRATO", "FORNECEDOR", "SITUAÇÃO", "INÍCIO", "FIM", "CLASSE FINANCEIRA (Nº)", "CLASSE FINANCEIRA (DESCRIÇÃO)",
           "CENTRO DE CUSTO (Nº)", "CENTRO DE CUSTO (DESCRIÇÃO)", "PROJETO (Nº)", "PROJETO (DESCRIÇÃO)",
           "VALOR INICIAL DO CONTRATO (R$)", "ADITIVO (R$)", "CONTRATADO + ADITIVO (R$)", "MEDIDO TOTAL (R$)", "SALDO ATUAL (R$)", "% UTILIZADO",
           *[f"{rot(m)} (R$)" for m in meses], "MEDIDO NO PERÍODO (R$)", "MESES COM MEDIÇÃO", "MÉDIA POR MÊS (R$)"]
    ws = wb.create_sheet("CONTRATOS MÊS A MÊS")
    base = {"emissao": "data de emissão", "vencimento": "data de vencimento"}.get(a.get("base") or "", "data da medição")
    exporter._faixa(ws, len(cab), "Contratos mês a mês",
                    f"Medido por mês de {rot(meses[0])} a {rot(meses[-1])} (pela {base}) · média por mês = medido no período ÷ meses que tiveram medição · "
                    "contrato com mais de uma classe: valores do contrato na 1ª linha")
    B = exporter.BRL
    exporter._tabela(ws, "tbContratosMes", cab, linhas or [[None] * len(cab)],
                     [None] * 3 + [exporter.DATA] * 2 + [None] * 6 + [B] * 5 + ["0.0%"] + [B] * len(meses) + [B, None, B],
                     [10, 36, 10, 11, 11, 11, 32, 11, 24, 10, 24, 17, 14, 17, 16, 16, 10] + [13] * len(meses) + [17, 11, 16])
    ws.freeze_panes = ws.cell(5, 3)


def gerar_excel(con, args, tipo="tudo"):
    """Excel das notas fiscais: medições (com os filtros da tela), contratos e prazos/feriados."""
    import exporter
    from openpyxl import Workbook
    wb = Workbook(); wb.remove(wb.active)
    D = lambda t: _d(t) or (t or None)          # data ISO -> data do Excel
    if tipo in ("tudo", "medicoes"):
        itens, pagina = [], 1
        while True:
            d = medicoes(con, {**args, "por": 2000, "pagina": pagina})
            itens += d["itens"]
            if pagina >= d["paginas"]:
                break
            pagina += 1
        ws = wb.create_sheet("MEDIÇÕES")
        # classe financeira em colunas próprias; NF com rateio vira uma linha por classe (VALOR NA CLASSE soma certo)
        dcc = {r["nome"]: r["descricao"] or "" for r in con.execute("SELECT nome, descricao FROM bud_centros")}
        dpj = {r["nome"]: r["descricao"] or "" for r in con.execute("SELECT nome, descricao FROM bud_projetos")}
        partes_med, partes_ped = {}, {}
        for tab, campo, dest in (("nf_rateio", "medicao_id", partes_med), ("bud_pedido_rateio", "pedido_id", partes_ped)):
            for r in con.execute(f"""SELECT r.{campo} AS k, r.pct, i.centro_custo, i.projeto, i.classe_numero, i.classe_descricao
                                     FROM {tab} r JOIN bud_itens i ON i.id = r.item_id ORDER BY r.id"""):
                dest.setdefault(r["k"], []).append(dict(r))
        cab = ["MEDIÇÃO", "NF", "CONTRATO", "PEDIDO", "FORNECEDOR",
               "CLASSE FINANCEIRA (Nº)", "CLASSE FINANCEIRA (DESCRIÇÃO)", "CENTRO DE CUSTO (Nº)", "CENTRO DE CUSTO (DESCRIÇÃO)",
               "PROJETO (Nº)", "PROJETO (DESCRIÇÃO)", "EMISSÃO", "VENCIMENTO", "DATA MEDIÇÃO", "VALOR DA NF (R$)", "RATEIO (%)",
               "VALOR NA CLASSE (R$)", "DIAS ÚTEIS (SLA)", "STATUS", "OBSERVAÇÃO"]
        exporter._faixa(ws, len(cab), "Medições", "Notas fiscais · com os filtros da tela · NF com rateio: uma linha por classe financeira")
        linhas = []
        for m in itens:
            partes = partes_med.get(m.get("id")) or (partes_ped.get(m.get("pedido_id")) if m.get("rateio_pedido") else None)
            if not partes:
                partes = [{"pct": 100.0, "centro_custo": m.get("classe_cc") or "", "projeto": m.get("classe_projeto") or "",
                           "classe_numero": m.get("classe_numero") or "", "classe_descricao": m.get("classe_descricao") or ""}]
            for p in partes:
                valor = m.get("valor") or 0
                linhas.append([m.get("numero_medicao"), m.get("numero_documento"), m.get("contrato"), m.get("pedido"), m.get("fornecedor"),
                               p["classe_numero"] or None, p["classe_descricao"] or None, p["centro_custo"] or None, dcc.get(p["centro_custo"], "") or None,
                               p["projeto"] or None, dpj.get(p["projeto"], "") or None,
                               D(m.get("data_emissao")), D(m.get("data_vencimento")), D(m.get("data_medicao")),
                               valor, (p["pct"] or 0) / 100, f"=ROUND(O{5 + len(linhas)}*P{5 + len(linhas)},2)",
                               m.get("dias_uteis"), m.get("status"), m.get("observacao")])
        exporter._tabela(ws, "tbMedicoes", cab, linhas or [[None] * len(cab)],
                         [None] * 11 + [exporter.DATA] * 3 + [exporter.BRL, "0.00%", exporter.BRL, None, None, None],
                         [11, 12, 10, 10, 34, 12, 34, 12, 26, 10, 26, 12, 12, 12, 15, 10, 16, 10, 12, 40])
    if tipo in ("tudo", "medicoes"):
        _aba_contratos_mes(wb, con, args)
    if tipo in ("tudo", "contratos"):
        ws = wb.create_sheet("CONTRATOS")
        cab = ["CONTRATO", "FORNECEDOR", "INÍCIO", "FIM", "SALDO CONTRATADO (R$)", "ADITIVO (R$)", "CONTRATADO + ADITIVO (R$)",
               "MEDIÇÕES (R$)", "SALDO ATUAL (R$)", "% UTILIZADO", "Nº DE MEDIÇÕES", "LINHAS", "FINALIZADO"]
        exporter._faixa(ws, len(cab), "Contratos", "Saldo atual = (saldo contratado + aditivo) − medições")
        linhas = [[c["numero"], c["fornecedor"], D(c["data_inicio"]), D(c["data_fim"]), c["saldo_contratado"], c["aditivo"], c["total_contratado"],
                   c["total_utilizado"], c["saldo_atual"], (c["pct_utilizado"] or 0) / 100 if c["pct_utilizado"] is not None else None,
                   c["n_medicoes"], c["n_itens"], "SIM" if c["finalizado"] else "NÃO"] for c in contratos(con)]
        B = exporter.BRL
        exporter._tabela(ws, "tbContratos", cab, linhas or [[None] * len(cab)], [None, None, exporter.DATA, exporter.DATA, B, B, B, B, B, "0.0%", None, None, None],
                         [10, 40, 12, 12, 16, 14, 18, 16, 16, 11, 11, 8, 11])
    if tipo == "tudo":
        ws = wb.create_sheet("PRAZOS E FERIADOS")
        exporter._faixa(ws, 4, "Prazos e feriados", "Data limite das NFs de cada mês e feriados")
        linhas = [[r["mes"], D(r["prazo"]), "PRAZO", r["email_gerado_em"]] for r in con.execute("SELECT * FROM nf_prazos ORDER BY mes")] + \
                 [[None, D(r["data"]), "FERIADO", r["descricao"] if "descricao" in r.keys() else ""] for r in con.execute("SELECT * FROM nf_feriados ORDER BY data")]
        exporter._tabela(ws, "tbPrazos", ["MÊS", "DATA", "TIPO", "OBSERVAÇÃO"], linhas or [[None] * 4], [None, exporter.DATA, None, None], [10, 12, 10, 30])
    buf = BytesIO(); wb.save(buf); buf.seek(0)
    return buf


def gerar_modelo():
    """Planilha de importação (exemplo) das notas fiscais: mesmas abas e colunas da EnviarEmailNF
    (DADOS, CONTRATOS, Cadastro, PRAZO RECEBIMENTO NFS, FERIADOS) + ITENS CONTRATO (opcional, budget)."""
    import exporter
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook()
    ws = wb.active
    ws.title = "LEIA-ME"
    exporter._faixa(ws, 8, "Planilha de importação (exemplo) · Notas fiscais", "Central de Engenharia · Engenharia & Infraestrutura")
    ws.sheet_view.showGridLines = False
    texto = [
        ("Como preencher", True),
        ("Mesmo formato da planilha EnviarEmailNF: dá para importar a planilha antiga ou esta. A linha 4 de cada aba é o cabeçalho.", False),
        ("As linhas preenchidas são EXEMPLOS: apague antes de importar. Importe em Notas fiscais › Medições (ou Contratos) › Importar planilha.", False),
        ("Nada é duplicado: medições e contratos que já existem só têm os campos vazios completados.", False),
        ("", False),
        ("Abas", True),
        ("CONTRATOS · nº do contrato, fornecedor, vigência, saldo contratado, aditivo e FINALIZADO (SIM/NÃO).", False),
        ("Cadastro · fornecedor → contrato (usado quando a coluna CONTRATO da aba DADOS está vazia).", False),
        ("DADOS · uma medição por linha. STATUS: ENVIADO (prosseguiu), PENDENTE ou CANCELADA. ITEM (opcional) = nº do item do contrato.", False),
        ("ITENS CONTRATO · (opcional) itens/linhas de cada contrato com Nº do centro de custo, Nº do projeto e Nº da classe financeira do budget.", False),
        ("      Use quando o contrato tem itens em projetos ou classes diferentes. Precisa da guia Budget para ver no site.", False),
        ("PRAZO RECEBIMENTO NFS · data limite para os fornecedores mandarem as NFs de cada mês.", False),
        ("FERIADOS · uma data por linha (não contam como dia útil).", False),
    ]
    for i, (t, b) in enumerate(texto, 5):
        ws.cell(i, 1, t).font = Font(name=exporter.FONTE, size=12 if b else 10, bold=b, color=exporter.ROXO if b else "1E002F")
    ws.column_dimensions["A"].width = 130
    hoje = dt.date.today()
    mes1 = hoje.replace(day=1)
    D, B, N = exporter.DATA, exporter.BRL, None
    abas = [
        ("CONTRATOS", "Contratos", "Saldo atual = (saldo contratado + aditivo) − medições", "tbContratos",
         ["CONTRATO", "FORNECEDOR", "DATA INÍCIO", "DATA FINAL", "SALDO CONTRATADO", "ADITIVO", "FINALIZADO"],
         [["9001", "FORNECEDOR EXEMPLO LTDA", hoje.replace(month=1, day=1), hoje.replace(month=12, day=31), 250000, 0, "NÃO"]],
         [N, N, D, D, B, B, N], [12, 40, 14, 14, 18, 14, 12]),
        ("Cadastro", "Cadastro", "Fornecedor → contrato", "tbCadastro",
         ["FORNECEDOR", "CONTRATO"], [["FORNECEDOR EXEMPLO LTDA", "9001"]], [N, N], [40, 14]),
        ("DADOS", "Medições", "Uma medição (NF) por linha", "tbDados",
         ["MEDIÇÃO", "NF", "CONTRATO", "FORNECEDOR", "ITEM", "DATA EMISSÃO", "DATA VENCIMENTO", "DATA MEDIÇÃO", "VALOR", "STATUS", "OBS", "CAMINHO NF"],
         [["30001", "12345", "9001", "FORNECEDOR EXEMPLO LTDA", "10", hoje, hoje + dt.timedelta(days=15), hoje, 18750.5, "ENVIADO", "",
           "C:\\Notas\\NF 12345.pdf"],
          ["30002", "12346", "9001", "FORNECEDOR EXEMPLO LTDA", "20", hoje, hoje + dt.timedelta(days=15), hoje, 4200, "PENDENTE", "Aguardando fiscal", ""]],
         [N, N, N, N, N, D, D, D, B, N, N, N], [10, 10, 10, 34, 8, 14, 16, 14, 14, 12, 30, 40]),
        ("ITENS CONTRATO", "Itens do contrato", "Opcional: cada item pode ter centro de custo, projeto e classe diferentes", "tbItensContrato",
         ["CONTRATO", "ITEM", "DESCRIÇÃO", "CENTRO DE CUSTO (Nº)", "PROJETO (Nº)", "CLASSE FINANCEIRA"],
         [["9001", "10", "Manutenção elétrica", "9010", "1002", "4.1.02"],
          ["9001", "20", "Manutenção hidráulica", "9010", "1001", "4.1.02"]],
         [N, N, N, N, N, N], [12, 8, 34, 22, 26, 18]),
        ("PRAZO RECEBIMENTO NFS", "Prazo de recebimento das NFs", "Data limite de cada mês", "tbPrazos",
         ["MÊS", "PRAZO", "STATUS"], [[mes1, mes1 + dt.timedelta(days=24), ""]], ["mm/yyyy", D, N], [12, 14, 14]),
        ("FERIADOS", "Feriados", "Uma data por linha", "tbFeriados",
         ["DATA", "DESCRIÇÃO"], [[dt.date(hoje.year, 11, 20), "Consciência Negra"], [dt.date(hoje.year, 12, 25), "Natal"]], [D, N], [14, 30]),
    ]
    for nome, tit, sub, tb, cab, linhas, fmts, larg in abas:
        w = wb.create_sheet(nome)
        exporter._faixa(w, max(len(cab), 4), tit, sub)
        exporter._tabela(w, tb, cab, linhas, fmts, larg)
        w.sheet_properties.tabColor = exporter.ROXO
    ws.sheet_properties.tabColor = exporter.VERDE_900
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def eh_planilha_nf(caminho):
    try:
        from python_calamine import CalamineWorkbook
        nomes = [importer.sem_acento(n).upper() for n in CalamineWorkbook.from_path(str(caminho)).sheet_names]
    except Exception:
        return False
    return "DADOS" in nomes and "CONTRATOS" in nomes


# ----------------------------------------------------------------------------- rotas
def registrar_rotas(app, guarda, registrar):
    def corpo():
        return request.get_json(silent=True) or {}

    # medições antigas sem dias úteis gravados (primeira vez depois da atualização)
    try:
        with db.connect() as con:
            recalcular_dias_uteis(con, so_vazios=True)
            atualizar_busca(con, so_vazios=True)
    except Exception:
        pass

    @app.get("/api/nf/base")
    @guarda
    def nf_base():
        """Dados pequenos usados em todas as telas: contratos (com totais), config, prazos, feriados."""
        with db.connect() as con:
            cfg = config(con)
            cs = contratos(con, cfg)
            return jsonify(
                contratos=cs, config=cfg, status=STATUS,
                prazos=[dict(r) for r in con.execute("SELECT * FROM nf_prazos ORDER BY mes DESC")],
                feriados=[dict(r) for r in con.execute("SELECT * FROM nf_feriados ORDER BY data DESC")],
                alertas={
                    "saldo": [c["id"] for c in cs if {"saldo_acabando", "saldo_negativo"} & set(c["alertas"])],
                    "vencimento": [c["id"] for c in cs if {"vencendo", "vencido"} & set(c["alertas"])],
                },
            )

    @app.get("/api/nf/medicoes")
    @guarda
    def nf_listar_medicoes():
        with db.connect() as con:
            return jsonify(medicoes(con, request.args))

    @app.get("/api/nf/medicoes/<int:mid>")
    @guarda
    def nf_uma_medicao(mid):
        with db.connect() as con:
            return jsonify(medicao(con, mid))

    @app.get("/api/nf/graficos")
    @guarda
    def nf_graficos():
        with db.connect() as con:
            return jsonify(graficos(con, request.args))

    # ---- configurações
    @app.post("/api/nf/config")
    @guarda
    def nf_salvar_config():
        d = corpo()
        with db.connect() as con:
            for k, v in d.items():
                if k not in CONFIG_PADRAO:
                    continue
                v = str(v if v is not None else "").strip()
                if k in NUMERICOS:
                    try:
                        n = float(v.replace(",", "."))
                    except ValueError:
                        abort(400, f"Valor inválido em {k}.")
                    if n < 0:
                        abort(400, "Use números positivos.")
                    v = str(int(n)) if n.is_integer() else str(n)
                con.execute("INSERT INTO nf_config(chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (k, v))
        return jsonify(ok=True)

    # ---- contratos
    @app.post("/api/nf/contratos")
    @guarda
    def nf_salvar_contrato():
        d = corpo()
        numero, forn = importer.txt(d.get("numero")), importer.up(d.get("fornecedor"))
        if not numero or not forn:
            abort(400, "Informe o número do contrato e o fornecedor.")
        campos = (numero, forn, importer.data_iso(d.get("data_inicio")) or "", importer.data_iso(d.get("data_fim")) or "",
                  importer.num(d.get("saldo_contratado")), importer.num(d.get("aditivo")),
                  1 if d.get("finalizado") else 0, importer.txt(d.get("observacao")))
        with db.connect() as con:
            outro = con.execute("SELECT id FROM nf_contratos WHERE numero=?", (numero,)).fetchone()
            if outro and outro["id"] != d.get("id"):
                return jsonify(erro=f"Já existe o contrato {numero}."), 409
            if d.get("id"):
                visao.exigir_contrato(con, int(d["id"]), gravar=True)
                con.execute("UPDATE nf_contratos SET numero=?, fornecedor=?, data_inicio=?, data_fim=?, saldo_contratado=?, "
                            "aditivo=?, finalizado=?, observacao=? WHERE id=?", (*campos, d["id"]))
                atualizar_busca(con, contrato_id=d["id"])
                cid = d["id"]
            else:
                cid = con.execute("INSERT INTO nf_contratos(numero, fornecedor, data_inicio, data_fim, saldo_contratado, aditivo, "
                                  "finalizado, observacao) VALUES (?,?,?,?,?,?,?,?)", campos).lastrowid
        return jsonify(ok=True, id=cid)

    @app.delete("/api/nf/contratos/<int:cid>")
    @guarda
    def nf_excluir_contrato(cid):
        with db.connect() as con:
            visao.exigir_contrato(con, cid)
            n = con.execute("SELECT COUNT(*) FROM nf_medicoes WHERE contrato_id=?", (cid,)).fetchone()[0]
            if n:
                return jsonify(erro=f"Este contrato tem {n} medição(ões). Marque como finalizado em vez de excluir."), 409
            con.execute("DELETE FROM nf_contratos WHERE id=?", (cid,))
        return jsonify(ok=True)

    # ---- medições
    @app.post("/api/nf/medicoes")
    @guarda
    def nf_salvar_medicao():
        f = request.form
        mid = int(f.get("id") or 0) or None
        if mid:
            with db.connect() as con:
                visao.exigir_medicao(con, mid, gravar=True)
        status = importer.up(f.get("status")) or "PROSSEGUIU"
        if status not in STATUS:
            status = "PROSSEGUIU"
        try:
            cid = int(f.get("contrato_id") or 0) or None
            pid = int(f.get("pedido_id") or 0) or None
        except ValueError:
            cid = pid = None
        if pid:
            cid = None          # NF de pedido de compra: não usa contrato
        if not cid and not pid:
            abort(400, "Escolha o contrato ou o pedido de compra.")
        if not (importer.txt(f.get("numero_medicao")) or importer.txt(f.get("numero_documento"))):
            abort(400, "Informe o número da medição ou o número do documento (NF).")
        campos = {
            "numero_medicao": importer.txt(f.get("numero_medicao")),
            "numero_documento": importer.txt(f.get("numero_documento")),
            "data_emissao": importer.data_iso(f.get("data_emissao")) or "",
            "data_vencimento": importer.data_iso(f.get("data_vencimento")) or "",
            "data_medicao": importer.data_iso(f.get("data_medicao")) or "",
            "valor": importer.num(f.get("valor")),
            "contrato_id": cid,
            "pedido_id": pid,
            "observacao": importer.txt(f.get("observacao")),
            "status": status,
        }
        arq = request.files.get("arquivo")
        with db.connect() as con:
            if cid and not con.execute("SELECT 1 FROM nf_contratos WHERE id=?", (cid,)).fetchone():
                abort(400, "Contrato não encontrado.")
            if pid and not con.execute("SELECT 1 FROM bud_pedidos WHERE id=?", (pid,)).fetchone():
                abort(400, "Pedido não encontrado.")
            if pid:
                campos["contrato_item_id"] = None
            campos["dias_uteis"] = dias_uteis(campos["data_emissao"], campos["data_medicao"], _feriados(con))
            if mid:
                sets = ", ".join(f"{k}=?" for k in campos)
                con.execute(f"UPDATE nf_medicoes SET {sets} WHERE id=?", (*campos.values(), mid))
            else:
                mid = con.execute(f"INSERT INTO nf_medicoes({', '.join(campos)}) VALUES ({', '.join('?' * len(campos))})",
                                  tuple(campos.values())).lastrowid
            if arq and arq.filename:
                antigo = con.execute("SELECT anexo_arquivo FROM nf_medicoes WHERE id=?", (mid,)).fetchone()["anexo_arquivo"]
                nome = arq.filename
                destino = f"{mid}_{uuid.uuid4().hex[:8]}_{secure_filename(nome) or 'nf' + Path(nome).suffix}"
                db.NF_DIR.mkdir(exist_ok=True)
                arq.save(db.NF_DIR / destino)
                con.execute("UPDATE nf_medicoes SET anexo_arquivo=?, anexo_nome=? WHERE id=?", (destino, nome, mid))
                if antigo:
                    (db.NF_DIR / antigo).unlink(missing_ok=True)
            atualizar_busca(con, ids=[mid])
        return jsonify(ok=True, id=mid)

    @app.delete("/api/nf/medicoes/<int:mid>")
    @guarda
    def nf_excluir_medicao(mid):
        with db.connect() as con:
            visao.exigir_medicao(con, mid)
            r = con.execute("SELECT anexo_arquivo FROM nf_medicoes WHERE id=?", (mid,)).fetchone()
            if not r:
                abort(404)
            con.execute("DELETE FROM nf_medicoes WHERE id=?", (mid,))
        if r["anexo_arquivo"]:
            lixeira.guardar(db.NF_DIR / r["anexo_arquivo"])
        return jsonify(ok=True)

    @app.post("/api/nf/medicoes/excluir")
    @guarda
    def nf_excluir_medicoes():
        """{ids: [...]} — exclui várias medições (e os arquivos das NFs)."""
        ids = [int(x) for x in corpo().get("ids") or []]
        arquivos = []
        with db.connect() as con:
            for mid in ids:
                visao.exigir_medicao(con, mid)
                r = con.execute("SELECT anexo_arquivo FROM nf_medicoes WHERE id=?", (mid,)).fetchone()
                if r and r["anexo_arquivo"]:
                    arquivos.append(r["anexo_arquivo"])
                con.execute("DELETE FROM nf_medicoes WHERE id=?", (mid,))
        for a in arquivos:
            lixeira.guardar(db.NF_DIR / a)
        return jsonify(ok=True, n=len(ids))

    @app.get("/api/nf/medicoes/ids")
    @guarda
    def nf_ids_medicoes():
        """Ids de todas as medições do filtro (para "selecionar todas")."""
        with db.connect() as con:
            ids, pagina = [], 1
            while True:
                d = medicoes(con, {**request.args, "por": 2000, "pagina": pagina})
                ids += [m["id"] for m in d["itens"]]
                if pagina >= d["paginas"]:
                    break
                pagina += 1
        return jsonify(ids)

    @app.get("/api/nf/medicoes/<int:mid>/anexo")
    @guarda
    def nf_baixar_anexo(mid):
        with db.connect() as con:
            m = medicao(con, mid)
        nome, caminho = _arquivo_anexo(m)
        if not caminho:
            abort(404, "Arquivo da NF não encontrado (o caminho da planilha antiga pode ter mudado).")
        return seguranca.enviar_anexo(caminho, nome, baixar=request.args.get("baixar") == "1")

    @app.get("/api/nf/medicoes/<int:mid>/email")
    @guarda
    def nf_email_medicao(mid):
        hora = int(request.args.get("hora", dt.datetime.now().hour))
        with db.connect() as con:
            m = medicao(con, mid)
            reenvio = bool(m["email_gerado_em"])
            modo = request.args.get("modo")
            d = email_medicao(m, hora, config(con), so_dados=True) if modo else None
            if modo == "dados":   # só preenche a janela: conta como gerado ao baixar ou abrir
                return jsonify({**d, "anexo_url": f"/api/nf/medicoes/{mid}/anexo?baixar=1" if d["com_anexo"] else ""})
            if not d:
                assunto, buf, com_anexo = email_medicao(m, hora, config(con))
            con.execute("UPDATE nf_medicoes SET email_gerado_em=datetime('now','localtime') WHERE id=?", (mid,))
        if d:   # o histórico grava em outra conexão: só depois de fechar esta
            registrar("reenviou e-mail da NF" if reenvio else "gerou e-mail da NF", d["assunto"])
            return jsonify(ok=True)
        registrar("reenviou e-mail da NF" if reenvio else "gerou e-mail da NF",
                  assunto + ("" if com_anexo else " (sem anexo: arquivo não encontrado)"))
        r = send_file(buf, as_attachment=True, download_name=_nome_arquivo(assunto), mimetype="message/rfc822")
        r.headers["X-Com-Anexo"] = "1" if com_anexo else "0"
        return r

    # ---- prazos (e-mail pedindo as NFs) e feriados
    @app.post("/api/nf/prazos")
    @guarda
    def nf_salvar_prazo():
        d = corpo()
        mes, prazo = (d.get("mes") or "")[:7], importer.data_iso(d.get("prazo"))
        if len(mes) != 7 or not prazo:
            abort(400, "Informe o mês e a data limite.")
        with db.connect() as con:
            con.execute("INSERT INTO nf_prazos(mes, prazo) VALUES (?,?) ON CONFLICT(mes) DO UPDATE SET prazo=excluded.prazo",
                        (mes, prazo))
        return jsonify(ok=True)

    @app.delete("/api/nf/prazos/<mes>")
    @guarda
    def nf_excluir_prazo(mes):
        with db.connect() as con:
            con.execute("DELETE FROM nf_prazos WHERE mes=?", (mes,))
        return jsonify(ok=True)

    @app.get("/api/nf/prazos/<mes>/email")
    @guarda
    def nf_email_prazo(mes):
        hora = int(request.args.get("hora", dt.datetime.now().hour))
        with db.connect() as con:
            p = con.execute("SELECT * FROM nf_prazos WHERE mes=?", (mes,)).fetchone()
            if not p:
                abort(404, "Cadastre o prazo desse mês primeiro.")
            reenvio = bool(p["email_gerado_em"])
            modo = request.args.get("modo")
            d = email_prazo(p["mes"], p["prazo"], hora, config(con), so_dados=True) if modo else None
            if modo == "dados":
                return jsonify({**d, "anexo_url": ""})
            if not d:
                assunto, buf = email_prazo(p["mes"], p["prazo"], hora, config(con))
            con.execute("UPDATE nf_prazos SET email_gerado_em=datetime('now','localtime') WHERE mes=?", (mes,))
        if d:
            registrar("reenviou e-mail de prazo das NFs" if reenvio else "gerou e-mail de prazo das NFs", d["assunto"])
            return jsonify(ok=True)
        registrar("reenviou e-mail de prazo das NFs" if reenvio else "gerou e-mail de prazo das NFs", assunto)
        return send_file(buf, as_attachment=True, download_name=_nome_arquivo(assunto), mimetype="message/rfc822")

    @app.post("/api/nf/feriados")
    @guarda
    def nf_salvar_feriado():
        d = corpo()
        data = importer.data_iso(d.get("data"))
        if not data:
            abort(400, "Informe a data do feriado.")
        with db.connect() as con:
            con.execute("INSERT INTO nf_feriados(data, descricao) VALUES (?,?) "
                        "ON CONFLICT(data) DO UPDATE SET descricao=excluded.descricao", (data, importer.txt(d.get("descricao"))))
            recalcular_dias_uteis(con)
        return jsonify(ok=True)

    @app.delete("/api/nf/feriados/<data>")
    @guarda
    def nf_excluir_feriado(data):
        with db.connect() as con:
            con.execute("DELETE FROM nf_feriados WHERE data=?", (data,))
            recalcular_dias_uteis(con)
        return jsonify(ok=True)

    # ---- importar a planilha antiga (EnviarEmailNF.xlsm)
    # ---- NF de pedido de compra (materiais e serviços avulsos, sem contrato)
    @app.get("/api/nf/pedidos")
    @guarda
    def nf_pedidos():
        """Pedidos para escolher na medição: nº, fornecedor, valor e quanto já foi medido."""
        with db.connect() as con:
            cond_v, par_v = visao.cond_pedido()
            return jsonify([dict(r) for r in con.execute(f"""
                SELECT p.id, p.numero, p.fornecedor, p.valor, p.data_emissao, p.status, p.descricao,
                       (SELECT COALESCE(SUM(m.valor),0) FROM nf_medicoes m WHERE m.pedido_id=p.id AND m.status<>'CANCELADA') AS medido
                FROM bud_pedidos p LEFT JOIN bud_itens i ON i.id = p.item_id WHERE {cond_v}
                ORDER BY p.data_emissao DESC, p.id DESC LIMIT 5000""", par_v)])

    @app.post("/api/nf/pedido-pdf")
    @guarda
    def nf_pedido_pdf():
        """Lê o PDF do pedido e já cadastra (ou completa) o pedido. Devolve o pedido para usar na medição."""
        import budget
        f = request.files.get("arquivo")
        if not f or not f.filename:
            abort(400, "Envie o PDF do pedido.")
        dados = f.read()
        with db.connect() as con:
            lido = budget.ler_pdfs(con, [(f.filename, dados)])[0]
            if lido.get("erro"):
                return jsonify(erro=lido["erro"]), 400
            if not lido.get("numero"):
                return jsonify(erro="Não achei o nº do pedido no PDF."), 400
            pid, novo = budget.salvar_pedido_lido(con, {**lido, "projeto": lido.get("projeto_numero")}, (f.filename, dados))
            p = dict(con.execute("SELECT id, numero, fornecedor, valor, data_emissao, status, descricao FROM bud_pedidos WHERE id=?", (pid,)).fetchone())
        return jsonify(pedido={**p, "medido": 0}, novo=novo, lido=lido)

    @app.get("/api/nf/exportar")
    @guarda
    def nf_exportar():
        tipo = request.args.get("tipo") or "tudo"
        with db.connect() as con:
            buf = gerar_excel(con, request.args, tipo)
        nome = {"medicoes": "Medições", "contratos": "Contratos"}.get(tipo, "Notas fiscais")
        return send_file(buf, as_attachment=True, download_name=f"{nome} - Central de Engenharia.xlsx",
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.get("/api/nf/modelo")
    @guarda
    def nf_modelo():
        return send_file(gerar_modelo(), as_attachment=True, download_name="PLANILHA DE IMPORTAÇÃO (EXEMPLO) - NOTAS FISCAIS.xlsx",
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.post("/api/nf/importar")
    @guarda
    def nf_importar():
        f = request.files.get("arquivo")
        if not f:
            abort(400, "Envie a planilha.")
        tmp = db.DATA_DIR / f"_nf_{uuid.uuid4().hex}{Path(f.filename or 'x.xlsm').suffix}"
        f.save(tmp)
        try:
            if not eh_planilha_nf(tmp):
                return jsonify(erro="Essa planilha não tem as abas DADOS e CONTRATOS (modelo EnviarEmailNF)."), 400
            res = importar_planilha(tmp)
        except Exception as ex:
            return jsonify(erro=f"Não consegui ler a planilha: {ex}"), 400
        finally:
            tmp.unlink(missing_ok=True)
        return jsonify(res)
