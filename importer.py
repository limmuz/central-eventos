"""Importação de planilhas.

1) importar_base(): lê a planilha "INFOS RELATÓRIO GERAL DE EVENTOS (POWER BI).xlsm" (formato antigo)
   ou o novo modelo exportado pelo site, e grava eventos/itens/medidores/chamados/catálogo.
2) resumir_anexo(): extrai a aba "Resumo" de um relatório de custos operacionais por evento
   (ex.: "Custos - Engenharia - FESTIVAL DEMO 01-10-26.xlsx") para mostrar no site.
"""
import datetime as dt
import re
import unicodedata

from python_calamine import CalamineWorkbook

import db

TIPOS_ITEM = {"AVARIAS": "AVARIAS", "AVARIA": "AVARIAS", "MDO": "MDO", "MDO TERCEIROS": "MDO",
              "MDO TERC": "MDO", "INSUMOS": "INSUMOS", "INSUMO": "INSUMOS"}
TIPOS_RELOGIO = {"AGUA": "ÁGUA", "ÁGUA": "ÁGUA", "GAS": "GÁS", "GÁS": "GÁS", "ELETRICA": "ELÉTRICA",
                 "ELÉTRICA": "ELÉTRICA", "ENERGIA": "ELÉTRICA", "POCO": "POÇO", "POÇO": "POÇO",
                 "IRRIGACAO": "IRRIGAÇÃO", "IRRIGAÇÃO": "IRRIGAÇÃO", "IRRIGACAO GRAMADO": "IRRIGAÇÃO", "IRRIGAÇÃO GRAMADO": "IRRIGAÇÃO"}


# ----------------------------------------------------------------------------- helpers
# texto que a planilha de importação mostra quando o Nº não está na guia LISTAS (conta como vazio ao importar)
AVISOS_LISTA = ("⚠", "NÃO ESTÁ NAS LISTAS")

def txt(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r"\s+", " ", str(v)).strip()


def up(v):
    return txt(v).upper()


def nome_evento(v):
    """Nome do evento em caixa alta, mantendo o 'x' de confronto: 'TIME A x TIME B'."""
    return re.sub(r" X ", " x ", up(v))


def completar_categorias(con):
    """Eventos sem categoria herdam de outro dia com o mesmo nome; 'TIME A x ...' vira JOGO."""
    con.execute("""UPDATE eventos SET
        categoria = (SELECT o.categoria FROM eventos o WHERE o.nome=eventos.nome AND o.categoria<>'' LIMIT 1),
        genero    = (SELECT o.genero FROM eventos o WHERE o.nome=eventos.nome AND o.categoria<>'' LIMIT 1)
        WHERE categoria='' AND EXISTS (SELECT 1 FROM eventos o WHERE o.nome=eventos.nome AND o.categoria<>'')""")
    con.execute("UPDATE eventos SET categoria='JOGO' WHERE categoria='' AND nome LIKE 'TIME A x %'")


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def num(v, default=0.0):
    if v in (None, ""):
        return default
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("R$", "").replace(" ", "").strip()
    if s in ("", "-"):
        return default
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return default


def data_iso(v):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, (int, float)) and v > 20000:  # serial do Excel
        return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()
    s = txt(v)
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d/%m/%y", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return ""


def hora(v):
    """Normaliza horários: time, '16;30', '16:30', fração do dia -> 'HH:MM'."""
    if v in (None, ""):
        return ""
    if isinstance(v, dt.datetime):
        v = v.time()
    elif isinstance(v, dt.date):      # 24:00 / 00:00 lido como data 01/01/1900
        return "00:00"
    if isinstance(v, dt.time):
        return f"{v.hour:02d}:{v.minute:02d}"
    if isinstance(v, dt.timedelta):
        m = int(v.total_seconds() // 60)
        return f"{(m // 60) % 24:02d}:{m % 60:02d}"
    if isinstance(v, (int, float)) and 0 <= v < 1:
        m = round(v * 24 * 60)
        return f"{(m // 60) % 24:02d}:{m % 60:02d}"
    s = txt(v).replace(";", ":").replace(".", ":").replace("h", ":")
    m = re.match(r"^(\d{1,2}):(\d{1,2})", s)
    if m:
        return f"{int(m.group(1)) % 24:02d}:{int(m.group(2)):02d}"
    return ""


def tipo_item(v):
    return TIPOS_ITEM.get(up(v), up(v) or "AVARIAS")


def tipo_relogio(v):
    k = up(v)
    return TIPOS_RELOGIO.get(k, TIPOS_RELOGIO.get(sem_acento(k), k))


def _sheet(wb, *nomes):
    alvo = [sem_acento(n).upper() for n in nomes]
    for n in wb.sheet_names:
        nn = sem_acento(n).upper()
        if any(a in nn for a in alvo):
            return wb.get_sheet_by_name(n).to_python()
    return None


def _sheet_exata(wb, *nomes):
    """Aba pelo nome exato (sem acento / maiúsculas); senão, a que contém o nome."""
    alvo = [sem_acento(n).upper() for n in nomes]
    for n in wb.sheet_names:
        if sem_acento(n).upper().strip() in alvo:
            return wb.get_sheet_by_name(n).to_python()
    return _sheet(wb, *nomes)


def _cols(header):
    return {sem_acento(up(h)): i for i, h in enumerate(header) if txt(h)}


# ----------------------------------------------------------------------------- base
def importar_base(caminho, substituir=True, complementar=False):
    """Importa a planilha base. Retorna um resumo com contagens.

    substituir=True: para cada evento presente na planilha, os itens/medidores/chamados
    desse evento são apagados e regravados (evita duplicar ao reimportar).
    complementar=True: NÃO apaga nem altera nada que já existe. Só preenche o que falta:
    avarias/MDO/insumos entram apenas nos eventos que ainda não têm aquele tipo de item;
    chamados, medidores e energia idem. Eventos novos da planilha são criados.
    """
    wb = CalamineWorkbook.from_path(str(caminho))
    novo_modelo = _eh_novo_modelo(wb.sheet_names)
    if novo_modelo:
        return _importar_novo_modelo(wb, substituir and not complementar, complementar)
    return _importar_modelo_antigo(wb, substituir and not complementar, complementar)


ABAS_NOVO_MODELO = ("EVENTOS", "ITENS", "MEDIDORES", "RELOGIOS", "CHAMADOS", "ENERGIA", "CATALOGO")


def _eh_novo_modelo(nomes):
    """Planilha de importação do site (ou o Excel exportado): basta UMA das abas (ex.: só ITENS com as avarias)."""
    nomes = [sem_acento(n).upper().strip() for n in nomes]
    return not any("DADOS EVENTOS" in n for n in nomes) and any(n in ABAS_NOVO_MODELO for n in nomes)


def eh_planilha_base(caminho):
    """True se o arquivo é a base do Power BI (modelo antigo: aba DADOS EVENTOS)
    ou o Excel exportado pelo site (abas EVENTOS + ITENS)."""
    try:
        nomes = [sem_acento(n).upper() for n in CalamineWorkbook.from_path(str(caminho)).sheet_names]
    except Exception:
        return False
    return any("DADOS EVENTOS" in n for n in nomes) or _eh_novo_modelo(nomes)


class _Gravador:
    def __init__(self, con, substituir, complementar=False):
        self.con = con
        self.substituir = substituir
        self.complementar = complementar
        self.cache = {}
        self.limpos = set()
        self.criados = set()
        self.ok = {}            # (evento, tabela, tipo) -> pode gravar? (decidido 1x, antes de gravar)
        self.pulados = {}       # tabela/tipo -> eventos que já tinham dados (não mexidos)
        self.preenchidos = {}   # tabela/tipo -> eventos que receberam dados
        self.cont = {"eventos_novos": 0, "itens": 0, "relogios": 0, "chamados": 0,
                     "energia_hora": 0, "catalogo": 0, "avarias": 0, "mdo": 0, "insumos": 0}

    def pode(self, eid, tabela, tipo=None):
        """No modo complementar: só grava se o evento ainda NÃO tinha nada daquele tipo
        antes desta importação (assim nada é duplicado)."""
        if not self.complementar:
            return True
        k = (eid, tabela, tipo)
        if k not in self.ok:
            q = f"SELECT 1 FROM {tabela} WHERE evento_id=?" + (" AND tipo=?" if tipo else "") + " LIMIT 1"
            existe = self.con.execute(q, (eid, tipo) if tipo else (eid,)).fetchone()
            self.ok[k] = not existe
            (self.pulados if existe else self.preenchidos).setdefault(tipo or tabela, set()).add(eid)
        return self.ok[k]

    def item(self, eid, tipo, item, valor_unit, qtd):
        if not self.pode(eid, "itens", tipo):
            return
        self.con.execute("INSERT INTO itens(evento_id,tipo,item,valor_unit,qtd) VALUES (?,?,?,?,?)",
                         (eid, tipo, item, valor_unit, qtd))
        self.cont["itens"] += 1
        if tipo.lower() in self.cont:
            self.cont[tipo.lower()] += 1

    def resumo(self):
        if self.complementar:   # não deixa evento vazio criado só por uma linha sem dados
            for eid in self.criados:
                tem = any(self.con.execute(f"SELECT 1 FROM {t} WHERE evento_id=? LIMIT 1", (eid,)).fetchone()
                          for t in ("itens", "chamados", "relogios", "energia_hora"))
                if not tem:
                    self.con.execute("DELETE FROM eventos WHERE id=?", (eid,))
                    self.cont["eventos_novos"] -= 1
        self.cont["complementar"] = self.complementar
        self.cont["pulados"] = {k: len(v) for k, v in self.pulados.items()}
        self.cont["preenchidos"] = {k: len(v) for k, v in self.preenchidos.items()}
        return self.cont

    def evento(self, nome, data, **extra):
        nome, data = nome_evento(nome), data_iso(data)
        if not nome or not data:
            return None
        k = (nome, data)
        if k in self.cache:
            eid = self.cache[k]
        else:
            r = self.con.execute("SELECT id FROM eventos WHERE nome=? AND data=?", k).fetchone()
            if not r:
                # mesmo evento com nome um pouco diferente no site (ex.: TIME A x TCB / TIME A x TIME C BRASIL):
                # único evento na data, ou nome parecido na mesma data
                achado, _ = resolver_evento(self.con, nome, data)
                r = {"id": achado} if achado else None
            if r:
                eid = r["id"]
            else:
                eid = self.con.execute("INSERT INTO eventos(nome, data) VALUES (?,?)", k).lastrowid
                self.cont["eventos_novos"] += 1
                self.criados.add(eid)
            self.cache[k] = eid
        campos = {c: v for c, v in extra.items() if v not in (None, "")}
        if campos and self.complementar:   # não sobrescreve o que já foi cadastrado no site
            atual = self.con.execute(f"SELECT {', '.join(campos)} FROM eventos WHERE id=?", (eid,)).fetchone()
            campos = {c: v for c, v in campos.items() if atual[c] in (None, "")}
        if campos:
            sets = ", ".join(f"{c}=?" for c in campos)
            self.con.execute(f"UPDATE eventos SET {sets} WHERE id=?", (*campos.values(), eid))
        return eid

    def limpar(self, eid, tabela, tipo=None):
        """Substituir: apaga o que o evento tinha (só daquele tipo, quando informado) antes de gravar o da planilha.
        Assim, importar só as AVARIAS de um evento não apaga a MDO nem os insumos dele."""
        k = (eid, tabela, tipo)
        if self.substituir and k not in self.limpos:
            if tipo:
                self.con.execute(f"DELETE FROM {tabela} WHERE evento_id=? AND tipo=?", (eid, tipo))
            else:
                self.con.execute(f"DELETE FROM {tabela} WHERE evento_id=?", (eid,))
            self.limpos.add(k)

    def catalogo(self, tipo, item, valor):
        item = up(item)
        if not item:
            return
        self.con.execute(
            "INSERT INTO catalogo(tipo,item,valor_unit) VALUES (?,?,?) "
            + ("ON CONFLICT(tipo,item) DO NOTHING" if self.complementar
               else "ON CONFLICT(tipo,item) DO UPDATE SET valor_unit=excluded.valor_unit"),
            (tipo, item, num(valor)))
        self.cont["catalogo"] += 1


def _importar_modelo_antigo(wb, substituir, complementar=False):
    with db.connect() as con:
        g = _Gravador(con, substituir, complementar)

        # Categoria/gênero vindos do TOTAL GERAL (para eventos que só têm medidores)
        cat_por_evento = {}
        tg = _sheet(wb, "TOTAL GERAL")
        if tg:
            c = _cols(tg[0])
            for r in tg[1:]:
                if txt(r[c.get("EVENTO", 0)]):
                    cat_por_evento[(nome_evento(r[c["EVENTO"]]), data_iso(r[c["DATA"]]))] = (
                        up(r[c.get("CATEGORIA", 2)]), up(r[c.get("GENERO", 3)]))

        # 1. DADOS EVENTOS
        dados = _sheet(wb, "DADOS EVENTOS")
        if dados:
            c = _cols(dados[0])
            for r in dados[1:]:
                nome, item = r[c["EVENTO"]], txt(r[c["ITEM"]])
                if not txt(nome):
                    continue
                eid = g.evento(nome, r[c["DATA"]], categoria=up(r[c["CATEGORIA"]]),
                               genero=up(r[c["GENERO"]]))
                if not eid or not item:
                    continue
                g.limpar(eid, "itens")
                g.item(eid, tipo_item(r[c["TIPO"]]), up(item), num(r[c["VALOR UNI. (R$)"]]), num(r[c["QTD."]]))

        for (nome, data), (cat, gen) in cat_por_evento.items():
            r = con.execute("SELECT id, categoria FROM eventos WHERE nome=? AND data=?", (nome, data)).fetchone()
            if r and not r["categoria"]:
                con.execute("UPDATE eventos SET categoria=?, genero=? WHERE id=?", (cat, gen, r["id"]))

        # 2. VALORES (catálogo): INSUMOS (A:B), AVARIAS (E:F), MDO (I:J)
        val = _sheet(wb, "VALORES")
        if val:
            for r in val[2:]:
                r = list(r) + [""] * 12
                g.catalogo("INSUMOS", r[0], r[1])
                g.catalogo("AVARIAS", r[4], r[5])
                g.catalogo("MDO", r[8], r[9])

        # 3. CHAMADOS (A:F)
        ch = _sheet(wb, "CHAMADOS")
        if ch:
            for r in ch[1:]:
                desc, nome = txt(r[0]), r[3]
                if not desc or not txt(nome):
                    continue
                cat = cat_por_evento.get((nome_evento(nome), data_iso(r[2])), ("", ""))
                eid = g.evento(nome, r[2])
                if not eid:
                    continue
                if cat[0]:
                    con.execute("UPDATE eventos SET categoria=?, genero=? WHERE id=? AND categoria=''",
                                (cat[0], cat[1], eid))
                g.limpar(eid, "chamados")
                if not eid or not g.pode(eid, "chamados"):
                    continue
                con.execute("INSERT INTO chamados(evento_id,descricao,tipo,hora_inicio,hora_final) VALUES (?,?,?,?,?)",
                            (eid, up(desc), up(r[1]), hora(r[4]), hora(r[5])))
                g.cont["chamados"] += 1

        # 4. MEDIDORES (A:E) e curva de energia (H:M) — aceita a aba antiga "RELOGIOS"
        rl = _sheet(wb, "MEDIDORES", "RELOGIOS")
        if rl:
            for r in rl[1:]:
                r = list(r) + [""] * 13
                if txt(r[0]) and txt(r[1]):
                    eid = g.evento(r[1], r[2])
                    if eid and g.pode(eid, "relogios", tipo_relogio(r[0])):
                        g.limpar(eid, "relogios")
                        con.execute(
                            "INSERT INTO relogios(evento_id,tipo,consumo,valor) VALUES (?,?,?,?) "
                            "ON CONFLICT(evento_id,tipo) DO UPDATE SET consumo=excluded.consumo, valor=excluded.valor",
                            (eid, tipo_relogio(r[0]), num(r[3]), num(r[4])))
                        g.cont["relogios"] += 1
                if txt(r[11]) and txt(r[8]):
                    eid = g.evento(r[11], r[12])
                    if eid and g.pode(eid, "energia_hora"):
                        g.limpar(eid, "energia_hora")
                        con.execute("INSERT INTO energia_hora(evento_id,ordem,data_consumo,hora,consumo) VALUES (?,?,?,?,?)",
                                    (eid, int(num(r[7])), data_iso(r[10]), hora(r[8]), num(r[9])))
                        g.cont["energia_hora"] += 1
        completar_categorias(con)
        res = g.resumo()
        con.commit()
        return res


def _importar_novo_modelo(wb, substituir, complementar=False):
    """Reimporta o Excel exportado pelo próprio site (abas EVENTOS, ITENS, MEDIDORES...)."""
    def tab(*nomes):
        d = _sheet_exata(wb, *nomes) or []
        # o modelo exportado tem 3 linhas de título antes do cabeçalho
        for i, r in enumerate(d[:12]):
            if any(sem_acento(up(x)) in ("EVENTO", "ID EVENTO", "TIPO", "ITEM") for x in r):
                c = _cols(r)
                # nomes alternativos de coluna (VALOR UNIT., VALOR UNITÁRIO, QUANTIDADE, QTD...)
                apelidos = {"VALOR UNIT. (R$)": ("VALOR UNIT", "VALOR UNITARIO", "VALOR"), "QTD.": ("QTD", "QUANT"),
                            "VALOR (R$)": ("VALOR",), "CONSUMO (KWH)": ("CONSUMO",), "DESCRICAO": ("DESCRI",), "INICIO": ("INICIO", "HORA INICIO", "ABERTURA"),
                            "FIM": ("FIM", "FINAL", "HORA FINAL", "HORA FIM"), "DATA CONSUMO": ("DATA CONSUMO",)}
                for k, alts in apelidos.items():
                    if k not in c:
                        achado = next((i2 for h, i2 in c.items() for a in alts if h.startswith(a)), None)
                        if achado is not None:
                            c[k] = achado
                linhas = [list(x) + [""] * (len(r) - len(x)) for x in d[i + 1:]]
                return [c, linhas]
        return [{}, []]

    with db.connect() as con:
        g = _Gravador(con, substituir, complementar)
        c, linhas = tab("EVENTOS")
        for r in linhas:
            if txt(r[c["EVENTO"]]):
                g.evento(r[c["EVENTO"]], r[c["DATA"]], categoria=up(r[c.get("CATEGORIA", 2)]),
                         genero=up(r[c.get("GENERO", 3)]), horario=hora(r[c["HORARIO"]]) if "HORARIO" in c else "",
                         publico=int(num(r[c["PUBLICO"]])) if "PUBLICO" in c and txt(r[c["PUBLICO"]]) else None,
                         cliente=txt(r[c["CLIENTE"]]) if "CLIENTE" in c else "")
        c, linhas = tab("ITENS")
        for r in linhas:
            if txt(r[c.get("EVENTO", 0)]) and txt(r[c["ITEM"]]):
                eid = g.evento(r[c["EVENTO"]], r[c["DATA"]])
                if not eid:
                    g.cont.setdefault("ignoradas", 0); g.cont["ignoradas"] += 1   # sem data válida
                    continue
                tp = tipo_item(r[c["TIPO"]])
                g.limpar(eid, "itens", tp)
                g.item(eid, tp, up(r[c["ITEM"]]), num(r[c["VALOR UNIT. (R$)"]]), num(r[c["QTD."]]) if "QTD." in c else 1)
        c, linhas = tab("MEDIDORES", "RELOGIOS")
        for r in linhas:
            if txt(r[c.get("EVENTO", 0)]) and txt(r[c["TIPO"]]):
                eid = g.evento(r[c["EVENTO"]], r[c["DATA"]])
                if not eid or not g.pode(eid, "relogios", tipo_relogio(r[c["TIPO"]])):
                    continue
                con.execute("INSERT INTO relogios(evento_id,tipo,consumo,valor) VALUES (?,?,?,?) "
                            "ON CONFLICT(evento_id,tipo) DO UPDATE SET consumo=excluded.consumo, valor=excluded.valor",
                            (eid, tipo_relogio(r[c["TIPO"]]), num(r[c["CONSUMO"]]), num(r[c["VALOR (R$)"]])))
                g.cont["relogios"] += 1
        c, linhas = tab("CHAMADOS")
        for r in linhas:
            if txt(r[c.get("EVENTO", 0)]) and txt(r[c["DESCRICAO"]]):
                eid = g.evento(r[c["EVENTO"]], r[c["DATA"]])
                if not eid or not g.pode(eid, "chamados"):
                    continue
                g.limpar(eid, "chamados")
                con.execute("INSERT INTO chamados(evento_id,descricao,tipo,hora_inicio,hora_final) VALUES (?,?,?,?,?)",
                            (eid, up(r[c["DESCRICAO"]]), up(r[c["TIPO"]]), hora(r[c["INICIO"]]), hora(r[c["FIM"]])))
                g.cont["chamados"] += 1
        c, linhas = tab("ENERGIA")
        for r in linhas:
            if txt(r[c.get("EVENTO", 0)]) and txt(r[c["HORA"]]):
                eid = g.evento(r[c["EVENTO"]], r[c["DATA"]])
                if not eid or not g.pode(eid, "energia_hora"):
                    continue
                g.limpar(eid, "energia_hora")
                con.execute("INSERT INTO energia_hora(evento_id,ordem,data_consumo,hora,consumo) VALUES (?,?,?,?,?)",
                            (eid, int(num(r[c["ORDEM"]])), data_iso(r[c["DATA CONSUMO"]]), hora(r[c["HORA"]]),
                             num(r[c["CONSUMO (KWH)"]])))
                g.cont["energia_hora"] += 1
        c, linhas = tab("CATALOGO")
        for r in linhas:
            if txt(r[c.get("ITEM", 1)]):
                g.catalogo(tipo_item(r[c["TIPO"]]), r[c["ITEM"]], r[c["VALOR UNIT. (R$)"]])
        completar_categorias(con)
        res = g.resumo()
        con.commit()
        return res


# ----------------------------------------------------------------------------- anexos
ROTULOS_TOTAL = ("SUBTOTAL", "TOTAL", "TOTAL 1", "TOTAL 2", "TOTAL GERAL")


def resumir_anexo(caminho):
    """Lê a aba 'Resumo' do relatório de custos operacionais. Retorna dict ou None."""
    try:
        wb = CalamineWorkbook.from_path(str(caminho))
    except Exception:
        return None
    nome = next((n for n in wb.sheet_names if sem_acento(n).upper().strip() == "RESUMO"), None)
    if not nome:
        return {"abas": wb.sheet_names}
    bruto = [list(r) for r in wb.get_sheet_by_name(nome).to_python(skip_empty_area=False)]
    # versão nova começa os blocos na coluna B; a antiga também, mas com rótulos do cabeçalho na C
    pos = _acha(bruto, "Departamento")
    base = pos[1] if pos else 0
    linhas = [r[base:] for r in bruto]
    info = {}
    for rot, chave in (("Evento", "evento"), ("Data do Evento", "data"), ("Horário do Evento", "horario"),
                       ("Público", "publico"), ("Cliente", "cliente")):
        v = _acha_rotulo(bruto, rot)
        if isinstance(v, (dt.date, dt.datetime)):
            v = data_iso(v)
        elif isinstance(v, dt.time):
            v = hora(v)
        if v not in (None, "", 0, 0.0):
            info[chave] = txt(v)
    grupos, totais = [], []
    grupo, titulo_solto = None, ""
    for r in linhas:
        r = list(r) + [""] * 6
        cel = [txt(x) for x in r[:6]]
        if up(cel[3]) == "VALOR" and up(cel[0]) in ("DEPARTAMENTO", "TIPO", "DATA"):
            grupo = {"titulo": titulo_solto if up(cel[0]) != "DEPARTAMENTO" else "", "linhas": []}
            titulo_solto = ""
            grupos.append(grupo)
            continue
        valor = r[3]
        e_num = isinstance(valor, (int, float))
        r2 = up(cel[2])
        global_ = r2.startswith("TOTAL GERAL") or re.match(r"^TOTAL \d+$", r2) is not None
        if e_num and global_:
            totais.append({"rotulo": cel[2], "valor": float(valor)})
            continue
        if grupo is not None and e_num and (r2 == "SUBTOTAL" or up(cel[0]) == "TOTAL" or (r2.startswith("TOTAL") and not cel[1])):
            grupo["subtotal"] = float(valor)
            continue
        if grupo is not None and e_num:
            linha = {"empresa": cel[2], "valor": float(valor)}
            if isinstance(r[1], (int, float)):          # Tipo | Qtde | Empresa | Valor
                linha.update(servico=cel[0], qtd=r[1])
            elif isinstance(r[0], (dt.date, dt.datetime)):  # Data | Serviço | Empresa | Valor
                linha.update(servico=cel[1], data=data_iso(r[0]))
            else:                                        # Departamento | Serviço | Empresa | Valor
                if cel[0] and not grupo["titulo"]:
                    grupo["titulo"] = cel[0]
                linha.update(servico=cel[1])
            grupo["linhas"].append(linha)
        elif cel[0] and not any(cel[1:4]):
            titulo_solto, grupo = cel[0], None
    vistos = {}
    for t in totais:  # rótulos repetidos (ex.: dois "TOTAL GERAL") ganham numeração
        vistos[t["rotulo"]] = vistos.get(t["rotulo"], 0) + 1
        if vistos[t["rotulo"]] > 1:
            t["rotulo"] = f'{t["rotulo"]} ({vistos[t["rotulo"]]})'
    for gr in grupos:
        gr["titulo"] = gr["titulo"] or "Outros"
    grupos = [g for g in grupos if g["linhas"]]
    return {"info": info, "grupos": grupos, "totais": totais, "abas": wb.sheet_names, "versao": versao_planilha(wb)}


# ----------------------------------------------------------------------------- dados do anexo
# Posições fixas do relatório de custos por evento (aba "Consumo" e aba "CHAMADOS CCO")
CELULAS_CONSUMO = {
    "evento": "C5", "data": "C6", "horario": "C7", "publico": "C8", "cliente": "C9",
    "ELÉTRICA": ("F15", "H17"),   # consumo kWh, total R$
    "GÁS": ("O15", "Q17"),
    "ÁGUA": ("X15", "Z17"),
    "POÇO": ("AF15", "AH17"),
}
ENERGIA_FAIXA = (21, 49)          # B21:C49 (B20/C20 são os títulos)
ENERGIA_CONTABILIZADA = ("06:00", "02:00")  # 06h do dia do evento até 02h do dia seguinte
CHAMADOS_INICIO = 8               # linha 8 em diante; C=solicitado, D=finalizado, F=área, G=descrição


def _ref(ref):
    m = re.match(r"([A-Z]+)(\d+)", ref.upper())
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return int(m.group(2)) - 1, col - 1


def _cel(L, ref):
    r, c = _ref(ref)
    return L[r][c] if r < len(L) and c < len(L[r]) else None


def siglas_atuais():
    with db.connect() as con:
        return {r["sigla"]: r["tipo"] for r in con.execute("SELECT sigla, tipo FROM siglas_area")}


def _acha(linhas, alvo, ini=0):
    """Posição (linha, coluna) da 1ª célula com esse texto (ignora acentos/maiúsculas/espaços)."""
    alvo = sem_acento(alvo).upper().strip()
    for i in range(ini, len(linhas)):
        for j, v in enumerate(linhas[i]):
            if isinstance(v, str) and sem_acento(v).upper().strip() == alvo:
                return i, j
    return None


def _acha_rotulo(L, rotulo, linhas=15, colunas=12):
    """Procura um rótulo (ex.: 'Evento:') no canto superior esquerdo e devolve o 1º valor à direita."""
    alvo = sem_acento(rotulo).upper()
    for r in range(min(linhas, len(L))):
        for c in range(min(colunas, len(L[r]))):
            v = L[r][c]
            if isinstance(v, str) and sem_acento(v).upper().strip().rstrip(":").strip() == alvo:
                for c2 in range(c + 1, min(c + 5, len(L[r]))):
                    if L[r][c2] not in ("", None) and not (isinstance(L[r][c2], str) and not L[r][c2].strip()):
                        return L[r][c2]
                return None
    return None


def versao_planilha(wb):
    """Modelo novo (C5:C9, com bloco de poço) ou modelo antigo (D4:D8, sem poço)."""
    abas = {sem_acento(n).upper().strip(): n for n in wb.sheet_names}
    if "CONSUMO" not in abas:
        return "desconhecida"
    L = wb.get_sheet_by_name(abas["CONSUMO"]).to_python(skip_empty_area=False)
    txt_topo = " ".join(str(x) for r in L[:12] for x in r if isinstance(x, str)).upper()
    if "MODELO ANTIGO" in txt_topo or "POR SHOW" in txt_topo:
        return "Modelo antigo"
    return "Modelo novo"


def dados_do_anexo(caminho, siglas=None):
    """Lê um relatório de custos por evento (modelo novo ou modelo antigo) e devolve:
    {versao, info:{evento,data,horario,publico,cliente}, relogios:[], energia:[], chamados:[], siglas_desconhecidas:[]}"""
    out = {"versao": "", "info": {}, "relogios": [], "energia": [], "chamados": [], "siglas_desconhecidas": []}
    try:
        wb = CalamineWorkbook.from_path(str(caminho))
    except Exception:
        return out
    siglas = siglas if siglas is not None else siglas_atuais()
    abas = {sem_acento(n).upper().strip(): n for n in wb.sheet_names}
    out["versao"] = versao_planilha(wb)

    # ---------------- Consumo
    if "CONSUMO" in abas:
        L = [list(r) for r in wb.get_sheet_by_name(abas["CONSUMO"]).to_python(skip_empty_area=False)]
        pub = num(_acha_rotulo(L, "Público"), None)
        cli = _acha_rotulo(L, "Cliente")
        out["info"] = {"evento": nome_evento(_acha_rotulo(L, "Evento")),
                       "data": data_iso(_acha_rotulo(L, "Data do Evento")),
                       "horario": hora(_acha_rotulo(L, "Horário do Evento")),
                       "publico": int(pub) if pub else None,
                       "cliente": "" if isinstance(cli, (int, float)) or cli is None else txt(cli)}
        # medidores: blocos na linha do título "ENERGIA ELÉTRICA" (mesma estrutura nas duas versões)
        pos = _acha(L, "ENERGIA ELÉTRICA")
        if pos:
            r0 = pos[0]
            titulos = {"ENERGIA ELETRICA": "ELÉTRICA", "GAS": "GÁS", "AGUA": "ÁGUA"}
            cab = L[r0 + 1] if r0 + 1 < len(L) else []
            dados = L[r0 + 2] if r0 + 2 < len(L) else []
            for c, v in enumerate(L[r0]):
                tipo = titulos.get(sem_acento(txt(v)).upper())
                if not tipo:
                    continue
                faixa = range(c, min(c + 8, len(cab)))
                col_cons = next((j for j in faixa if sem_acento(txt(cab[j])).upper() in ("CONSUMO", "CONSUMO TOTAL")), None)
                col_tot = next((j for j in faixa if sem_acento(txt(cab[j])).upper() == "TOTAL"), None)
                empresa = up(dados[c + 1]) if c + 1 < len(dados) else ""
                if tipo == "ÁGUA" and "POCO" in sem_acento(empresa):
                    tipo = "POÇO"
                elif tipo == "ÁGUA" and ("IRRIGA" in sem_acento(empresa) or "GRAMADO" in sem_acento(empresa)):
                    tipo = "IRRIGAÇÃO"
                custo_m3 = None
                for j in faixa:
                    if sem_acento(txt(cab[j])).upper().startswith("CUSTO M") and j < len(dados):
                        custo_m3 = num(dados[j], None)
                valor = None
                for rr in range(r0 + 2, min(r0 + 7, len(L))):
                    for j in faixa:
                        if j < len(L[rr]) and up(L[rr][j]) == "SUBTOTAL" and j + 1 < len(L[rr]):
                            valor = num(L[rr][j + 1], None)
                if valor is None and col_tot is not None and col_tot < len(dados):
                    valor = num(dados[col_tot], None)
                consumo = num(dados[col_cons], None) if col_cons is not None and col_cons < len(dados) else None
                if tipo == "IRRIGAÇÃO" and not consumo and not valor:
                    continue
                if valor is not None or consumo is not None:
                    out["relogios"].append({"tipo": tipo, "consumo": round(consumo or 0, 3), "valor": round(valor or 0, 2),
                                            "custo_m3": custo_m3})
        irrigacao_do_anexo(wb, abas, out["relogios"])
        for r in out["relogios"]:
            r.pop("custo_m3", None)
        # energia por hora: abaixo do título "Horario"; só a janela contabilizada (06h -> 02h do dia seguinte)
        pos = _acha(L, "Horario")
        horas = []
        if pos:
            rh, ch = pos
            vazias = 0
            for rr in range(rh + 1, min(rh + 40, len(L))):
                linha = L[rr] + [""] * (ch + 2)
                h = hora(linha[ch])
                if not h:
                    vazias += 1
                    if vazias >= 2:
                        break
                    continue
                vazias = 0
                horas.append((h, linha[ch + 1]))
        ini = next((i for i, (h, _) in enumerate(horas) if h == ENERGIA_CONTABILIZADA[0]), None)
        if ini is not None:
            fim = next((i for i in range(ini + 1, len(horas)) if horas[i][0] == ENERGIA_CONTABILIZADA[1]), len(horas) - 1)
            base = out["info"].get("data")
            virou = False
            for h, v in horas[ini:fim + 1]:
                if h == "00:00":
                    virou = True
                dc = base
                if base and virou:
                    dc = (dt.date.fromisoformat(base) + dt.timedelta(days=1)).isoformat()
                if isinstance(v, (int, float)):
                    out["energia"].append({"hora": h, "consumo": float(v), "data_consumo": dc})

    # ---------------- CHAMADOS CCO (colunas achadas pelos títulos Solicitado / Finalizado / ÁREA)
    nome_ch = next((abas[k] for k in abas if "CHAMADO" in k), None)
    if nome_ch:
        L = [list(r) for r in wb.get_sheet_by_name(nome_ch).to_python(skip_empty_area=False)]
        p_sol = _acha(L, "Solicitado")
        p_fim = _acha(L, "Finalizado")
        p_area = _acha(L, "ÁREA")
        if p_sol and p_area:
            r_ini = p_sol[0] + 1
            c_ini, c_fim = p_sol[1], (p_fim[1] if p_fim else p_sol[1] + 1)
            c_area = p_area[1]
            c_desc = c_area + 1
            desconhecidas = set()
            vazias = 0
            for r in range(r_ini, len(L)):
                linha = L[r] + [""] * (c_desc + 2)
                desc, area = txt(linha[c_desc]), up(linha[c_area])
                if not desc and not area:
                    vazias += 1
                    if vazias >= 5:
                        break
                    continue
                vazias = 0
                if not desc or "OCORRENCIAS DO PLANTAO" in sem_acento(desc).upper():
                    if desc:
                        break
                    continue
                tipo = siglas.get(area, area)
                if area and area not in siglas:
                    desconhecidas.add(area)
                out["chamados"].append({"descricao": up(desc), "tipo": tipo, "sigla": area,
                                        "hora_inicio": hora(linha[c_ini]), "hora_final": hora(linha[c_fim])})
            out["siglas_desconhecidas"] = sorted(desconhecidas)
    if out["versao"] != "desconhecida":
        out["versao"] += " · " + ("com poço" if any(r["tipo"] == "POÇO" for r in out["relogios"]) else "sem poço")
    return out


def irrigacao_do_anexo(wb, abas, relogios):
    """Irrigação do gramado (jogos, a partir de out/2026). Valor:
    1) bloco 'CÁLCULO DO CUSTO IRRIGAÇÃO' da aba Infraestrutura (Cons. Total m³ x Valor m³);
    2) medidor 'IRRIGAÇÃO GRAMADO' da aba Consumo; sem custo do m³, usa o custo do m³ da água (Sabesp) do evento."""
    atual = next((r for r in relogios if r["tipo"] == "IRRIGAÇÃO"), None)
    calc = None
    nome = abas.get("INFRAESTRUTURA")
    if nome:
        L = [list(r) for r in wb.get_sheet_by_name(nome).to_python(skip_empty_area=False)]
        ini = next((i for i, r in enumerate(L) if any("CALCULO DO CUSTO IRRIGA" in sem_acento(txt(v)).upper() for v in r)), None)
        # planilhas antigas (antes de out/2026) têm só uma ESTIMATIVA fixa (horas/dia x m³ x dias de utilização):
        # essa não conta. A partir de certo evento o bloco traz o consumo medido (Cons. Total m³ x Valor m³).
        estimativa = ini is not None and any(
            any("TEMPO FUNC" in sem_acento(txt(v)).upper() or "DIAS DE UTILIZA" in sem_acento(txt(v)).upper() for v in r)
            for r in L[ini + 1:ini + 8])
        if ini is not None and (not estimativa or atual is not None):
            achado = {}
            for r in L[ini + 1:ini + 8]:
                rot = next((sem_acento(txt(v)).upper() for v in r if isinstance(v, str) and v.strip()), "")
                nums = [v for v in r if isinstance(v, (int, float)) and not isinstance(v, bool)]
                if not rot or not nums:
                    continue
                if rot.startswith("CONS"):
                    achado["consumo"] = nums[-1]
                elif rot.startswith("VALOR M"):
                    achado["custo"] = nums[-1]
                elif rot.startswith("TOTAL"):
                    achado["valor"] = nums[-1]
            if achado.get("consumo") and not achado.get("valor") and achado.get("custo"):
                achado["valor"] = achado["consumo"] * achado["custo"]
            if achado.get("valor"):
                calc = {"tipo": "IRRIGAÇÃO", "consumo": round(achado.get("consumo") or 0, 3), "valor": round(achado["valor"], 2)}
    if calc:
        if atual:
            atual.update(calc)
        else:
            relogios.append(calc)
        return
    if atual and not atual["valor"] and atual["consumo"]:
        agua = next((r for r in relogios if r["tipo"] == "ÁGUA"), None)
        custo = atual.get("custo_m3") or (agua and (agua.get("custo_m3") or (agua["valor"] / agua["consumo"] if agua["consumo"] else None)))
        if custo:
            atual["valor"] = round(atual["consumo"] * custo, 2)


def aplicar_dados_anexo(con, eid, d, relogios=True, energia=True, chamados=True, cadastro=True):
    """Grava no evento o que foi lido do anexo (substitui o que havia)."""
    feito = {}
    info = d.get("info") or {}
    if cadastro:
        campos = {k: info.get(k) for k in ("horario", "publico", "cliente") if info.get(k)}
        if campos:
            con.execute(f"UPDATE eventos SET {', '.join(k + '=?' for k in campos)} WHERE id=?", (*campos.values(), eid))
            feito["cadastro"] = len(campos)
    if relogios and d["relogios"]:
        # a planilha manda: troca o conjunto inteiro (versão antiga não tem poço)
        con.execute("DELETE FROM relogios WHERE evento_id=?", (eid,))
        for r in d["relogios"]:
            con.execute("INSERT INTO relogios(evento_id,tipo,consumo,valor) VALUES (?,?,?,?) "
                        "ON CONFLICT(evento_id,tipo) DO UPDATE SET consumo=excluded.consumo, valor=excluded.valor",
                        (eid, r["tipo"], r["consumo"], r["valor"]))
        feito["relogios"] = len(d["relogios"])
    if energia and d["energia"]:
        con.execute("DELETE FROM energia_hora WHERE evento_id=?", (eid,))
        for i, h in enumerate(d["energia"], 1):
            con.execute("INSERT INTO energia_hora(evento_id,ordem,data_consumo,hora,consumo) VALUES (?,?,?,?,?)",
                        (eid, i, h.get("data_consumo") or "", h["hora"], h["consumo"]))
        feito["energia"] = len(d["energia"])
    if chamados and d["chamados"]:
        con.execute("DELETE FROM chamados WHERE evento_id=?", (eid,))
        for c in d["chamados"]:
            con.execute("INSERT INTO chamados(evento_id,descricao,tipo,hora_inicio,hora_final) VALUES (?,?,?,?,?)",
                        (eid, c["descricao"], c["tipo"], c["hora_inicio"], c["hora_final"]))
        feito["chamados"] = len(d["chamados"])
    return feito


# ----------------------------------------------------------------------------- encontrar o evento de um anexo
def _chave_nome(s):
    s = sem_acento(up(s)).replace(" X ", " ")
    return re.sub(r"[^A-Z0-9 ]", " ", s).split()


def semelhanca(a, b):
    """0..1 — compara nomes tolerando abreviações (TCB x TIME C BRASIL, LDE x LIGA DEMO ESPORTES)."""
    import difflib
    ta, tb = _chave_nome(a), _chave_nome(b)
    if len(ta) > 1 and len(tb) > 1 and ta[:2] == tb[:2] == ["TIME", "A"]:   # "TIME A x ..." não conta como semelhança
        ta, tb = ta[1:], tb[1:]
    if not ta or not tb:
        return 0.0
    sa, sb = " ".join(ta), " ".join(tb)
    r = difflib.SequenceMatcher(None, sa, sb).ratio()
    # sigla: LDE = Liga Demo Esportes ; TCB = Time C Brasil
    sig_b = "".join(t[0] for t in tb)
    sig_a = "".join(t[0] for t in ta)
    if any(t == sig_b or t.startswith(sig_b) for t in ta if len(t) >= 2 and len(sig_b) >= 2) or any(t == sig_a for t in tb if len(t) >= 2):
        r = max(r, 0.8)
    # palavras em comum (TIME D x TIME D UNIDOS; BANDA X x BANDA X - TURNÊ FINAL)
    comuns = set(ta) & set(tb) - {"TIME", "A"}
    if comuns:
        r = max(r, 0.6 + 0.4 * len(comuns) / max(len(set(ta) - {"TIME", "A"}), len(set(tb) - {"TIME", "A"}), 1))
    return r


def resolver_evento(con, nome, data):
    """Procura o evento da planilha: 1) mesmo nome e data; 2) único evento na data;
    3) evento da data com nome parecido. Retorna (id ou None, como_achou)."""
    if not nome or not data:
        return None, ""
    r = con.execute("SELECT id FROM eventos WHERE nome=? AND data=?", (nome, data)).fetchone()
    if r:
        return r["id"], "nome e data"
    mesmos_dia = con.execute("SELECT id, nome FROM eventos WHERE data=?", (data,)).fetchall()
    if len(mesmos_dia) == 1:
        return mesmos_dia[0]["id"], f"data (cadastrado como {mesmos_dia[0]['nome']})"
    if mesmos_dia:
        melhor = max(mesmos_dia, key=lambda e: semelhanca(nome, e["nome"]))
        if semelhanca(nome, melhor["nome"]) >= 0.6:
            return melhor["id"], f"data e nome parecido ({melhor['nome']})"
    return None, ""


def info_do_nome_arquivo(nome, ano_padrao=None):
    """'Custos - Engenharia - HISTORIAS 22-08-26.xlsx' -> ('HISTORIAS', '2026-08-22')"""
    base = re.sub(r"\.[^.]+$", "", nome or "")
    m = re.search(r"(\d{1,2})[-_.](\d{1,2})(?:[-_.](\d{2,4}))?\s*$", base.strip())
    if not m:
        return None, None
    d, mth, a = int(m.group(1)), int(m.group(2)), m.group(3)
    ano = (2000 + int(a) if a and len(a) == 2 else int(a)) if a else (ano_padrao or dt.date.today().year)
    try:
        data = dt.date(ano, mth, d).isoformat()
    except ValueError:
        return None, None
    nome_ev = base[:m.start()].strip(" -_")
    nome_ev = re.sub(r"(?i)^(c[oó]pia de\s+)?custos?\s*-\s*engenharia\s*-\s*", "", nome_ev).strip(" -_")
    return nome_evento(nome_ev), data


def conflito_nome_arquivo(nome_arquivo, info):
    """Se o nome do arquivo traz uma data diferente de C6, devolve (nome, data) do arquivo."""
    if not info or not info.get("data"):
        return None
    ano = int(info["data"][:4])
    n, d = info_do_nome_arquivo(nome_arquivo, ano)
    if d and d != info["data"]:
        return n, d
    return None


def reorganizar_anexos(con, pasta):
    rel = {"movidos": [], "repetidos_removidos": 0, "eventos_removidos": [], "reaplicados": 0, "sem_evento": [],
           "conflitos": []}
    conflitantes = set()
    anexos = con.execute("SELECT * FROM anexos ORDER BY enviado_em, id").fetchall()
    eventos_mexidos = set()
    infos = {}
    for a in anexos:
        cam = pasta / a["arquivo"]
        if not cam.exists() or not a["nome_original"].lower().endswith((".xlsx", ".xlsm", ".xls")):
            continue
        d = dados_do_anexo(cam)
        infos[a["id"]] = d
        info = d.get("info") or {}
        if not info.get("data"):
            continue
        conf = conflito_nome_arquivo(a["nome_original"], info)
        if conf:
            conflitantes.add(a["id"])
            rel["conflitos"].append(f"{a['nome_original']}: as células C5/C6 dizem {info.get('evento')} "
                                    f"{info['data']}, mas o nome do arquivo diz {conf[1]}. Valores NÃO puxados.")
            info = {"evento": conf[0], "data": conf[1]}
        dono, como = resolver_evento(con, info.get("evento"), info.get("data"))
        # se o dono encontrado é um evento criado automaticamente (duplicado), procura o "original" na mesma data
        if dono:
            outros = con.execute("SELECT id, nome FROM eventos WHERE data=? AND id<>? ORDER BY id", (info["data"], dono)).fetchall()
            atual = con.execute("SELECT nome FROM eventos WHERE id=?", (dono,)).fetchone()
            orig = [o for o in outros if o["id"] < dono and semelhanca(atual["nome"], o["nome"]) >= 0.6]
            if orig:
                dono = orig[0]["id"]
        if not dono:
            rel["sem_evento"].append(a["nome_original"])
            continue
        if dono != a["evento_id"]:
            con.execute("UPDATE anexos SET evento_id=? WHERE id=?", (dono, a["id"]))
            eventos_mexidos.add(a["evento_id"])
            ev = con.execute("SELECT nome, data FROM eventos WHERE id=?", (dono,)).fetchone()
            rel["movidos"].append(f"{a['nome_original']} → {ev['nome']} {ev['data']}")
    # repetidos (mesmo arquivo no mesmo evento)
    vistos = {}
    for a in con.execute("SELECT * FROM anexos ORDER BY enviado_em, id").fetchall():
        k = (a["evento_id"], a["nome_original"], a["tamanho"])
        if k in vistos:
            (pasta / a["arquivo"]).unlink(missing_ok=True)
            con.execute("DELETE FROM anexos WHERE id=?", (a["id"],))
            rel["repetidos_removidos"] += 1
        else:
            vistos[k] = a["id"]
    # eventos duplicados que ficaram sem anexos e sem itens
    for eid in eventos_mexidos:
        e = con.execute("SELECT id, nome, data FROM eventos WHERE id=?", (eid,)).fetchone()
        if not e:
            continue
        n_anexos = con.execute("SELECT COUNT(*) FROM anexos WHERE evento_id=?", (eid,)).fetchone()[0]
        n_itens = con.execute("SELECT COUNT(*) FROM itens WHERE evento_id=?", (eid,)).fetchone()[0]
        if n_anexos == 0 and n_itens == 0:
            con.execute("DELETE FROM eventos WHERE id=?", (eid,))
            rel["eventos_removidos"].append(f"{e['nome']} {e['data']}")
        elif n_anexos == 0:
            # ficou sem planilha: os dados puxados dela não valem mais
            for t in ("relogios", "chamados", "energia_hora"):
                con.execute(f"DELETE FROM {t} WHERE evento_id=?", (eid,))
    # puxa de novo os dados de cada planilha no seu evento (a mais recente de cada evento vale)
    for a in con.execute("SELECT * FROM anexos ORDER BY enviado_em, id").fetchall():
        d = infos.get(a["id"])
        if a["id"] in conflitantes:
            continue
        if d and (d.get("info") or {}).get("data"):
            ev = con.execute("SELECT data FROM eventos WHERE id=?", (a["evento_id"],)).fetchone()
            if ev and ev["data"] == d["info"]["data"]:
                aplicar_dados_anexo(con, a["evento_id"], d)
                rel["reaplicados"] += 1
    return rel
