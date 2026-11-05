"""Visão de Budget e Notas fiscais por conta: quais centros de custo e projetos a pessoa enxerga.

usuarios.visao: NULL = tudo; {"centros": [...], "projetos": [...]} = só o que estiver nessas listas (basta um dos dois).
Vale no que está ligado a uma linha do budget: linhas, medições, pedidos, contratos, gráficos e Excel. Registro sem
centro de custo nem projeto fica escondido de quem tem visão restrita. As listas de cadastro continuam completas.
"""
import json

from flask import abort, g, has_request_context

_leitor = None
_leitor_area = None


def configurar(leitor, leitor_area=None):
    """leitor(): devolve a visão de quem está usando o site (app.py sabe quem é). leitor_area(): a área dos Documentos."""
    global _leitor, _leitor_area
    _leitor, _leitor_area = leitor, leitor_area


def ler(texto):
    """Texto gravado em usuarios.visao -> dict (ou None = tudo)."""
    if not texto:
        return None
    try:
        v = json.loads(texto)
    except ValueError:
        return None
    return {"centros": list(v.get("centros") or []), "projetos": list(v.get("projetos") or [])} if isinstance(v, dict) else None


def atual():
    if _leitor is None or not has_request_context():
        return None
    if "visao" not in g:
        g.visao = _leitor()
    return g.visao


def cond_item(a="i"):
    """(sql, parâmetros) que limita as linhas do budget (bud_itens com o apelido a)."""
    v = atual()
    if v is None:
        return "1=1", []
    partes, par = [], []
    for campo, valores in (("centro_custo", v["centros"]), ("projeto", v["projetos"])):
        if valores:
            partes.append(f"{a}.{campo} IN ({','.join('?' * len(valores))})")
            par += valores
    return ("(" + " OR ".join(partes) + ")", par) if partes else ("1=0", [])


def cond_medicao():
    """Medição visível: a classe dela (bi) ou alguma parte do rateio, da NF ou do pedido. Precisa dos apelidos m e bi."""
    if atual() is None:
        return "1=1", []
    bi, pb = cond_item("bi")
    i, pi = cond_item("i")
    return (f"""({bi} OR EXISTS (SELECT 1 FROM nf_rateio r JOIN bud_itens i ON i.id = r.item_id WHERE r.medicao_id = m.id AND {i})
        OR EXISTS (SELECT 1 FROM bud_pedido_rateio r JOIN bud_itens i ON i.id = r.item_id WHERE r.pedido_id = m.pedido_id AND {i}))""",
            pb + pi + pi)


def cond_pedido():
    """Pedido visível: a classe dele (i = bud_itens do pedido) ou alguma parte do rateio. Precisa dos apelidos p e i."""
    if atual() is None:
        return "1=1", []
    i, pi = cond_item("i")
    ri, pr = cond_item("ri")
    return f"({i} OR EXISTS (SELECT 1 FROM bud_pedido_rateio r JOIN bud_itens ri ON ri.id = r.item_id WHERE r.pedido_id = p.id AND {ri}))", pi + pr


def cond_contrato():
    """Contrato visível: a classe padrão ou alguma linha dele. Precisa do apelido c."""
    if atual() is None:
        return "1=1", []
    i, pi = cond_item("i")
    return (f"""EXISTS (SELECT 1 FROM bud_itens i WHERE {i} AND (i.id = c.budget_item_id
        OR i.id IN (SELECT x.budget_item_id FROM nf_contrato_itens x WHERE x.contrato_id = c.id)))""", pi)


def ids_itens(con):
    """Linhas do budget visíveis (set de ids) ou None = todas."""
    if atual() is None:
        return None
    c, par = cond_item("i")
    return {r[0] for r in con.execute(f"SELECT i.id FROM bud_itens i WHERE {c}", par)}


def permite(centro_custo, projeto):
    v = atual()
    return v is None or centro_custo in v["centros"] or projeto in v["projetos"]


def _nega():
    # 404: para quem não tem a visão, o registro não existe
    abort(404, "Registro não encontrado.")


def exigir_item(con, iid):
    ids = ids_itens(con)
    if ids is not None and iid not in ids:
        _nega()


def exigir_medicao(con, mid, gravar=False):
    """gravar=True também deixa passar a medição ainda sem classe: é assim que a tela completa um lançamento novo."""
    if atual() is None:
        return
    import nf
    c, par = cond_medicao()
    if con.execute(f"SELECT 1 {nf._FROM} WHERE m.id=? AND {c}", [mid, *par]).fetchone():
        return
    if gravar and con.execute(f"""SELECT 1 {nf._FROM} WHERE m.id=? AND bi.id IS NULL
            AND NOT EXISTS (SELECT 1 FROM nf_rateio r WHERE r.medicao_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM bud_pedido_rateio r WHERE r.pedido_id = m.pedido_id)""", (mid,)).fetchone():
        return
    _nega()


def exigir_pedido(con, pid, gravar=False):
    if atual() is None:
        return
    c, par = cond_pedido()
    if con.execute(f"SELECT 1 FROM bud_pedidos p LEFT JOIN bud_itens i ON i.id = p.item_id WHERE p.id=? AND {c}", [pid, *par]).fetchone():
        return
    if gravar and con.execute("""SELECT 1 FROM bud_pedidos p WHERE p.id=? AND p.item_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM bud_pedido_rateio r WHERE r.pedido_id = p.id)""", (pid,)).fetchone():
        return
    _nega()


def exigir_contrato(con, cid, gravar=False):
    if atual() is None:
        return
    c, par = cond_contrato()
    if con.execute(f"SELECT 1 FROM nf_contratos c WHERE c.id=? AND {c}", [cid, *par]).fetchone():
        return
    if gravar and con.execute("""SELECT 1 FROM nf_contratos c WHERE c.id=? AND c.budget_item_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM nf_contrato_itens x WHERE x.contrato_id = c.id AND x.budget_item_id IS NOT NULL)""", (cid,)).fetchone():
        return
    _nega()


def renomear(con, chave, antigo, novo):
    """Centro de custo ou projeto mudou de número: quem via o antigo continua vendo. chave = 'centros' ou 'projetos'."""
    for r in con.execute("SELECT id, visao FROM usuarios WHERE visao IS NOT NULL").fetchall():
        v = ler(r["visao"])
        if v and antigo in v[chave]:
            v[chave] = sorted({novo if x == antigo else x for x in v[chave]})
            con.execute("UPDATE usuarios SET visao=? WHERE id=?", (json.dumps(v, ensure_ascii=False), r["id"]))


# ---- Documentos: cada conta vê os da sua área (administrador, PC do site e senha única veem todos)
def area_docs():
    """None = todas as áreas; "" = conta sem área (não vê nenhum); texto = só essa área."""
    if _leitor_area is None or not has_request_context():
        return None
    if "area_docs" not in g:
        g.area_docs = _leitor_area()
    return g.area_docs


def cond_doc(a="d"):
    area = area_docs()
    return ("1=1", []) if area is None else (f"{a}.area = ?", [area])


def exigir_doc(con, did):
    c, par = cond_doc("d")
    if not con.execute(f"SELECT 1 FROM doc_documentos d WHERE d.id=? AND {c}", [did, *par]).fetchone():
        _nega()
