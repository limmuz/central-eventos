"""Cálculos compartilhados (totais por evento, tempo de chamado, SLA)."""
SLA_MINUTOS = 60
# itens de MDO que contam como "técnico de transporte vertical" (elevador / escada rolante)
PALAVRAS_TV = ("ELEVADOR", "ESCADA ROLANTE")


def minutos(inicio, fim):
    """Duração em minutos entre 'HH:MM' e 'HH:MM' (vira a meia-noite se precisar)."""
    try:
        h1, m1 = map(int, inicio.split(":"))
        h2, m2 = map(int, fim.split(":"))
    except (ValueError, AttributeError):
        return None
    d = (h2 * 60 + m2) - (h1 * 60 + m1)
    if d < 0:
        d += 24 * 60
    return d


def sla(t):
    if t is None:
        return ""
    return "DENTRO DO SLA" if t <= SLA_MINUTOS else "FORA DO SLA"


def eventos_com_totais(con, where="", params=()):
    q = f"""
    SELECT e.*,
      COALESCE((SELECT SUM(valor_unit*qtd) FROM itens i WHERE i.evento_id=e.id AND i.tipo='MDO'),0)      AS mdo,
      COALESCE((SELECT SUM(valor_unit*qtd) FROM itens i WHERE i.evento_id=e.id AND i.tipo='AVARIAS'),0)  AS avarias,
      COALESCE((SELECT SUM(valor_unit*qtd) FROM itens i WHERE i.evento_id=e.id AND i.tipo='INSUMOS'),0)  AS insumos,
      COALESCE((SELECT SUM(qtd) FROM itens i WHERE i.evento_id=e.id AND i.tipo='MDO'
                AND (i.item LIKE '%ELEVADOR%' OR i.item LIKE '%ESCADA ROLANTE%')),0)                      AS tecnicos_tv,
      COALESCE((SELECT SUM(valor_unit*qtd) FROM itens i WHERE i.evento_id=e.id AND i.tipo='MDO'
                AND (i.item LIKE '%ELEVADOR%' OR i.item LIKE '%ESCADA ROLANTE%')),0)                      AS tecnicos_tv_valor,
      COALESCE((SELECT SUM(qtd) FROM itens i WHERE i.evento_id=e.id AND i.tipo='MDO'
                AND (i.item LIKE '%ACÚSTICA%' OR i.item LIKE '%ACUSTICA%')),0)                            AS acustica,
      COALESCE((SELECT SUM(valor_unit*qtd) FROM itens i WHERE i.evento_id=e.id AND i.tipo='MDO'
                AND (i.item LIKE '%ACÚSTICA%' OR i.item LIKE '%ACUSTICA%')),0)                            AS acustica_valor,
      COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='ÁGUA'),0)                AS agua,
      COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='GÁS'),0)                 AS gas,
      COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='ELÉTRICA'),0)            AS eletrica,
      COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='POÇO'),0)                AS poco,
      COALESCE((SELECT valor FROM relogios r WHERE r.evento_id=e.id AND r.tipo='IRRIGAÇÃO'),0)           AS irrigacao,
      COALESCE((SELECT consumo FROM relogios r WHERE r.evento_id=e.id AND r.tipo='ÁGUA'),0)              AS agua_consumo,
      COALESCE((SELECT consumo FROM relogios r WHERE r.evento_id=e.id AND r.tipo='GÁS'),0)               AS gas_consumo,
      COALESCE((SELECT consumo FROM relogios r WHERE r.evento_id=e.id AND r.tipo='ELÉTRICA'),0)          AS eletrica_consumo,
      COALESCE((SELECT consumo FROM relogios r WHERE r.evento_id=e.id AND r.tipo='POÇO'),0)              AS poco_consumo,
      COALESCE((SELECT consumo FROM relogios r WHERE r.evento_id=e.id AND r.tipo='IRRIGAÇÃO'),0)         AS irrigacao_consumo,
      (SELECT COUNT(*) FROM relogios r WHERE r.evento_id=e.id)                                           AS n_relogios,
      (SELECT COUNT(*) FROM itens i WHERE i.evento_id=e.id)                                              AS n_itens,
      (SELECT COUNT(*) FROM anexos a WHERE a.evento_id=e.id)                                             AS n_anexos
    FROM eventos e {where}
    ORDER BY e.data DESC, e.nome
    """
    evs = [dict(r) for r in con.execute(q, params).fetchall()]
    # chamados: tempo médio e SLA
    stats = {}
    for c in con.execute("SELECT evento_id, hora_inicio, hora_final FROM chamados"):
        s = stats.setdefault(c["evento_id"], [0, []])
        s[0] += 1
        t = minutos(c["hora_inicio"], c["hora_final"])
        if t is not None:
            s[1].append(t)
    for e in evs:
        # irrigação do gramado já está dentro da conta de água (Sabesp) dos jogos: é só o detalhe, não soma
        e["relogios"] = round(e["agua"] + e["gas"] + e["eletrica"] + e["poco"], 2)
        e["total"] = round(e["mdo"] + e["avarias"] + e["insumos"] + e["relogios"], 2)
        n, tempos = stats.get(e["id"], (0, []))
        e["n_chamados"] = n
        e["tempo_medio"] = round(sum(tempos) / len(tempos), 1) if tempos else None
        e["pct_sla"] = round(100 * sum(1 for t in tempos if t <= SLA_MINUTOS) / len(tempos), 1) if tempos else None
    return evs
