"""Vencimento de documentos (alvará da arena, auditoria interna e outros).

Cada documento tem datas de renovação e vencimento, um prazo de aviso (dias antes do vencimento)
e um histórico de anexos: cada renovação guarda o arquivo novo sem apagar os anteriores.
Situação: VENCIDO (vencimento já passou), VENCENDO (dentro do prazo de aviso), EM DIA ou SEM DATA.
"""
import calendar
import datetime as dt
import re
import uuid
from pathlib import Path

from flask import abort, jsonify, request, send_file
from werkzeug.utils import secure_filename

import db
import importer
import lixeira
import seguranca
import visao

DOCS_DIR = db.DATA_DIR / "documentos"
CATEGORIAS_PADRAO = ["ALVARÁ DA ARENA", "AUDITORIA INTERNA"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS doc_documentos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    nome             TEXT NOT NULL,
    categoria        TEXT DEFAULT '',
    numero           TEXT DEFAULT '',      -- nº do documento / protocolo
    orgao            TEXT DEFAULT '',      -- órgão emissor / área
    responsavel      TEXT DEFAULT '',
    data_renovacao   TEXT DEFAULT '',      -- última renovação / emissão
    data_vencimento  TEXT DEFAULT '',
    aviso_dias       INTEGER DEFAULT 60,   -- avisar X dias antes do vencimento
    observacao       TEXT DEFAULT '',
    arquivado        INTEGER DEFAULT 0,
    criado_em        TEXT DEFAULT (datetime('now','localtime')),
    atualizado_em    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS doc_anexos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    documento_id     INTEGER NOT NULL REFERENCES doc_documentos(id) ON DELETE CASCADE,
    arquivo          TEXT NOT NULL,
    nome_original    TEXT NOT NULL,
    tamanho          INTEGER,
    data_renovacao   TEXT DEFAULT '',      -- datas desta versão do documento
    data_vencimento  TEXT DEFAULT '',
    observacao       TEXT DEFAULT '',
    enviado_por      TEXT DEFAULT '',
    enviado_em       TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_doc_venc ON doc_documentos(data_vencimento);
CREATE INDEX IF NOT EXISTS ix_doc_anexos_doc ON doc_anexos(documento_id);
"""


def _d(t):
    try:
        return dt.date.fromisoformat((t or "")[:10])
    except ValueError:
        return None


PERIODICIDADES = [(0, "Sem periodicidade"), (1, "Mensal"), (2, "Bimestral"), (3, "Trimestral"), (6, "Semestral"),
                  (12, "Anual"), (24, "A cada 2 anos"), (36, "A cada 3 anos"), (60, "A cada 5 anos")]


def somar_meses(data, meses):
    """'2025-08-19' + 12 meses -> '2026-08-19' (dia 31 vira o último dia do mês)."""
    d = _d(data)
    if not d or not meses:
        return ""
    m = d.month - 1 + int(meses)
    a, m = d.year + m // 12, m % 12 + 1
    return dt.date(a, m, min(d.day, calendar.monthrange(a, m)[1])).isoformat()


def situacao(doc, hoje=None):
    hoje = hoje or dt.date.today()
    v = _d(doc["data_vencimento"])
    if doc.get("em_processo"):
        return "EM PROCESSO", (v - hoje).days if v else None
    if not v:
        return "SEM DATA", None
    dias = (v - hoje).days
    if dias < 0:
        return "VENCIDO", dias
    if dias <= (doc["aviso_dias"] if doc["aviso_dias"] is not None else 60):
        return "VENCENDO", dias
    return "EM DIA", dias


AREA_PADRAO = "ENGENHARIA"


def listar(con):
    docs = []
    cond_v, par_v = visao.cond_doc("d")
    for r in con.execute(f"""
        SELECT d.*, SUM(CASE WHEN COALESCE(a.arquivo,'') <> '' THEN 1 ELSE 0 END) AS n_anexos,
               SUM(CASE WHEN COALESCE(a.data_renovacao,'') <> '' THEN 1 ELSE 0 END) AS n_renovacoes,
               MAX(CASE WHEN COALESCE(a.arquivo,'') <> '' THEN a.id END) AS ultimo_anexo_id
        FROM doc_documentos d LEFT JOIN doc_anexos a ON a.documento_id = d.id
        WHERE {cond_v} GROUP BY d.id ORDER BY d.arquivado, d.data_vencimento = '', d.data_vencimento, d.nome""", par_v):
        d = dict(r)
        d["n_anexos"], d["n_renovacoes"] = d["n_anexos"] or 0, d["n_renovacoes"] or 0
        d["situacao"], d["dias_para_vencer"] = situacao(d)
        docs.append(d)
    # arquivo mais recente = o da renovação com a data mais nova que tem arquivo (empate: a linha mais nova)
    ult = {}
    for r in con.execute("""SELECT id, documento_id, nome_original, enviado_em, data_renovacao FROM doc_anexos
                            WHERE COALESCE(arquivo,'') <> '' ORDER BY COALESCE(data_renovacao,''), id"""):
        ult[r["documento_id"]] = dict(r)
    for d in docs:
        d["ultimo_anexo"] = ult.get(d["id"])
        d["ultimo_anexo_id"] = d["ultimo_anexo"]["id"] if d["ultimo_anexo"] else None
    return docs


COLS_PLANILHA = ["NOME DO DOCUMENTO", "CATEGORIA", "Nº / PROTOCOLO", "ÓRGÃO / ÁREA", "RESPONSÁVEL",
                 "DATA DE RENOVAÇÃO", "DATA DE VENCIMENTO", "AVISAR (DIAS ANTES)", "OBSERVAÇÃO"]


def importar_planilha(con, caminho):
    """Guia DOCUMENTOS da planilha de importação. Documento com o mesmo nome e categoria é atualizado
    (só as células preenchidas); os outros são cadastrados. Os arquivos (PDF) continuam sendo anexados no site."""
    from python_calamine import CalamineWorkbook
    wb = CalamineWorkbook.from_path(str(caminho))
    nome_aba = next((n for n in wb.sheet_names if importer.sem_acento(n).upper().strip() == "DOCUMENTOS"), None)
    res = {"novos": 0, "atualizados": 0, "ja_existiam": 0, "avisos": []}
    if not nome_aba:
        return None
    d = wb.get_sheet_by_name(nome_aba).to_python()
    alvo = importer.sem_acento("NOME DO DOCUMENTO")
    cab_i = next((i for i, r in enumerate(d[:10]) if any(importer.sem_acento(importer.up(x)) == alvo for x in r)), None)
    if cab_i is None:
        return res
    cab = [importer.sem_acento(importer.up(x)) for x in d[cab_i]]
    pos = {h: k for k, h in enumerate(cab) if h}

    def col(linha, h):
        k = pos.get(importer.sem_acento(h))
        v = linha[k] if k is not None and k < len(linha) else None
        return "" if isinstance(v, str) and v.startswith(importer.AVISOS_LISTA) else v

    for n_linha, linha in enumerate(d[cab_i + 1:], cab_i + 2):
        nome = importer.txt(col(linha, "NOME DO DOCUMENTO"))
        if not nome:
            continue
        campos = {
            "categoria": importer.up(col(linha, "CATEGORIA")), "numero": importer.txt(col(linha, "Nº / PROTOCOLO")),
            "orgao": importer.txt(col(linha, "ÓRGÃO / ÁREA")), "responsavel": importer.txt(col(linha, "RESPONSÁVEL")),
            "data_renovacao": importer.data_iso(col(linha, "DATA DE RENOVAÇÃO")) or "",
            "data_vencimento": importer.data_iso(col(linha, "DATA DE VENCIMENTO")) or "",
            "observacao": importer.txt(col(linha, "OBSERVAÇÃO")),
        }
        aviso = col(linha, "AVISAR (DIAS ANTES)")
        if importer.txt(aviso):
            try:
                campos["aviso_dias"] = max(0, int(float(str(aviso).replace(",", "."))))
            except ValueError:
                res["avisos"].append(f"Linha {n_linha}: “AVISAR (DIAS ANTES)” não é número ({aviso}).")
        # documento de outra área não é tocado: com o mesmo nome, vira um documento próprio da área de quem importou
        cond_v, par_v = visao.cond_doc("d")
        atual = con.execute(f"SELECT * FROM doc_documentos d WHERE UPPER(nome)=UPPER(?) AND categoria=? AND {cond_v}", (nome, campos["categoria"], *par_v)).fetchone()
        if atual:
            muda = {k: v for k, v in campos.items() if v not in ("", None) and atual[k] != v}
            if muda:
                sets = ", ".join(f"{k}=?" for k in muda)
                con.execute(f"UPDATE doc_documentos SET {sets}, atualizado_em=datetime('now','localtime') WHERE id=?", (*muda.values(), atual["id"]))
                res["atualizados"] += 1
            else:
                res["ja_existiam"] += 1
        else:
            if visao.area_docs() == "":
                res["avisos"].append(f"Linha {n_linha}: sua conta não tem área definida. Peça ao administrador.")
                continue
            campos = {"nome": nome, "area": visao.area_docs() or AREA_PADRAO, **campos}
            campos.setdefault("aviso_dias", 60)
            con.execute(f"INSERT INTO doc_documentos({', '.join(campos)}) VALUES ({', '.join('?' * len(campos))})", tuple(campos.values()))
            res["novos"] += 1
    return res


def recalcular(con, did):
    """Datas do documento = a renovação mais recente da lista de renovações (e o vencimento dela)."""
    r = con.execute("SELECT data_renovacao, data_vencimento FROM doc_anexos WHERE documento_id=? AND COALESCE(data_renovacao,'') <> '' "
                    "ORDER BY data_renovacao DESC, id DESC LIMIT 1", (did,)).fetchone()
    if r:
        doc = con.execute("SELECT periodicidade_meses FROM doc_documentos WHERE id=?", (did,)).fetchone()
        venc = r["data_vencimento"] or somar_meses(r["data_renovacao"], doc["periodicidade_meses"])
        con.execute("UPDATE doc_documentos SET data_renovacao=?, data_vencimento=?, atualizado_em=datetime('now','localtime') WHERE id=?",
                    (r["data_renovacao"], venc, did))


def _migrar(con):
    cols = [r[1] for r in con.execute("PRAGMA table_info(doc_documentos)")]
    if "area" not in cols:   # os documentos que já existiam ficam em Engenharia
        con.execute("ALTER TABLE doc_documentos ADD COLUMN area TEXT DEFAULT ''")
        con.execute("UPDATE doc_documentos SET area=?", (AREA_PADRAO,))
    if "periodicidade_meses" not in cols:
        con.execute("ALTER TABLE doc_documentos ADD COLUMN periodicidade_meses INTEGER")
    if "em_processo" not in cols:
        con.execute("ALTER TABLE doc_documentos ADD COLUMN em_processo INTEGER DEFAULT 0")
    # documentos vindos da planilha de renovação: "Periodicidade: anual (12 meses). Renovações anteriores: dd/mm/aaaa, ..."
    # viram periodicidade + linhas na lista de renovações (a observação fica só com o resto, ex.: a pasta)
    for d in con.execute("SELECT * FROM doc_documentos WHERE periodicidade_meses IS NULL AND observacao LIKE 'Periodicidade:%'").fetchall():
        obs = d["observacao"] or ""
        m = re.match(r"^Periodicidade: [^(]*\((\d+) meses\)\.\s*", obs)
        if not m:
            continue
        meses, resto = int(m.group(1)), obs[m.end():]
        datas = []
        m2 = re.match(r"^Renovações anteriores: ([\d/, ]+)\.\s*", resto)
        if m2:
            datas = [importer.data_iso(x.strip()) for x in m2.group(1).split(",") if x.strip()]
            resto = resto[m2.end():]
        if d["data_renovacao"]:
            datas.append(d["data_renovacao"])
        ja = {r[0] for r in con.execute("SELECT data_renovacao FROM doc_anexos WHERE documento_id=?", (d["id"],))}
        for x in sorted(set(filter(None, datas)) - ja):
            con.execute("INSERT INTO doc_anexos(documento_id, arquivo, nome_original, tamanho, data_renovacao, data_vencimento, observacao, enviado_por) "
                        "VALUES (?,?,?,?,?,?,?,?)", (d["id"], "", "", 0, x, somar_meses(x, meses), "importada da planilha de renovação", "planilha"))
        con.execute("UPDATE doc_documentos SET periodicidade_meses=?, observacao=? WHERE id=?", (meses, resto.strip(), d["id"]))
        recalcular(con, d["id"])


def registrar_rotas(app, guarda, registrar, quem):
    with db.connect() as con:
        con.executescript(SCHEMA)
        _migrar(con)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    def salvar_arquivo(con, doc_id, arq, ren="", venc="", obs=""):
        nome = arq.filename or "documento"
        destino = f"{doc_id}_{uuid.uuid4().hex[:8]}_{secure_filename(nome) or 'arquivo' + Path(nome).suffix}"
        DOCS_DIR.mkdir(parents=True, exist_ok=True)
        arq.save(DOCS_DIR / destino)
        con.execute("INSERT INTO doc_anexos(documento_id, arquivo, nome_original, tamanho, data_renovacao, data_vencimento, "
                    "observacao, enviado_por) VALUES (?,?,?,?,?,?,?,?)",
                    (doc_id, destino, nome, (DOCS_DIR / destino).stat().st_size, ren, venc, obs, quem()))

    @app.get("/api/docs/exportar")
    @guarda
    def docs_exportar():
        import exporter
        from io import BytesIO
        from openpyxl import Workbook
        wb = Workbook(); ws = wb.active; ws.title = "DOCUMENTOS"
        cab = ["DOCUMENTO", "CATEGORIA", "PERIODICIDADE", "ÓRGÃO / ÁREA", "RESPONSÁVEL", "ÚLTIMA RENOVAÇÃO", "VENCIMENTO",
               "AVISAR (DIAS ANTES)", "SITUAÇÃO", "DIAS PARA VENCER", "RENOVAÇÕES", "ARQUIVADO", "OBSERVAÇÃO"]
        nper = dict(PERIODICIDADES)
        exporter._faixa(ws, len(cab), "Documentos", "Vencimentos e renovações")
        with db.connect() as con:
            linhas = [[d["nome"], d["categoria"], nper.get(d["periodicidade_meses"] or 0, f"{d['periodicidade_meses']} meses"), d["orgao"], d["responsavel"],
                       _d(d["data_renovacao"]), _d(d["data_vencimento"]), d["aviso_dias"], d["situacao"], d["dias_para_vencer"], d["n_renovacoes"],
                       "SIM" if d["arquivado"] else "NÃO", d["observacao"]]
                      for d in listar(con)]
        exporter._tabela(ws, "tbDocumentos", cab, linhas or [[None] * len(cab)], [None] * 5 + [exporter.DATA] * 2 + [None] * 6,
                         [34, 20, 16, 20, 18, 14, 14, 12, 12, 12, 10, 10, 40])
        buf = BytesIO(); wb.save(buf); buf.seek(0)
        return send_file(buf, as_attachment=True, download_name="Documentos - Central de Engenharia.xlsx",
                         mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    @app.get("/api/docs")
    @guarda
    def docs_listar():
        with db.connect() as con:
            docs = listar(con)
            cats = sorted({d["categoria"] for d in docs if d["categoria"]} | set(CATEGORIAS_PADRAO))
            ativos = [d for d in docs if not d["arquivado"]]
            return jsonify(documentos=docs, categorias=cats, alertas={
                "vencidos": [d["id"] for d in ativos if d["situacao"] == "VENCIDO"],
                "vencendo": [d["id"] for d in ativos if d["situacao"] == "VENCENDO"],
                "em_processo": [d["id"] for d in ativos if d["situacao"] == "EM PROCESSO"],
            }, periodicidades=PERIODICIDADES)

    @app.get("/api/docs/<int:did>/anexos")
    @guarda
    def docs_anexos(did):
        with db.connect() as con:
            visao.exigir_doc(con, did)
            return jsonify(db.rows(con.execute("SELECT * FROM doc_anexos WHERE documento_id=? ORDER BY id DESC", (did,))))

    @app.post("/api/docs")
    @guarda
    def docs_salvar():
        """Dados principais do documento: nome, categoria, responsável, periodicidade, situação (em processo) e observação.
        As datas saem da lista de renovações (POST /api/docs/<id>/renovacoes)."""
        f = request.form
        did = int(f.get("id") or 0) or None
        nome = importer.txt(f.get("nome"))
        if not nome:
            abort(400, "Informe o nome do documento.")
        campos = {"nome": nome, "categoria": importer.up(f.get("categoria")), "responsavel": importer.txt(f.get("responsavel")),
                  "observacao": importer.txt(f.get("observacao"))}
        if "periodicidade_meses" in f:
            try:
                campos["periodicidade_meses"] = max(0, int(f.get("periodicidade_meses") or 0))
            except ValueError:
                campos["periodicidade_meses"] = 0
        if "situacao" in f:
            campos["em_processo"] = 1 if f.get("situacao") == "EM PROCESSO" else 0
        if "arquivado" in f:
            campos["arquivado"] = 1 if f.get("arquivado") in ("1", "true", "on") else 0
        for k in ("numero", "orgao"):           # campos antigos: só mudam se vierem (importação, telas antigas)
            if k in f:
                campos[k] = importer.txt(f.get(k))
        if "aviso_dias" in f:
            try:
                campos["aviso_dias"] = max(0, int(float(f.get("aviso_dias") or 60)))
            except ValueError:
                pass
        arq = request.files.get("arquivo")
        area = visao.area_docs()
        if area == "":
            return jsonify(erro="Sua conta não tem área definida. Peça ao administrador."), 403
        if area is None and importer.up(f.get("area")):   # administrador escolhe a área; os outros criam na própria
            campos["area"] = importer.up(f.get("area"))
        elif not did:
            campos["area"] = area or AREA_PADRAO
        with db.connect() as con:
            if "area" in campos and not con.execute("SELECT 1 FROM areas WHERE nome=?", (campos["area"],)).fetchone():
                abort(400, "Essa área não está cadastrada.")
            if did:
                visao.exigir_doc(con, did)
                sets = ", ".join(f"{k}=?" for k in campos)
                con.execute(f"UPDATE doc_documentos SET {sets}, atualizado_em=datetime('now','localtime') WHERE id=?", (*campos.values(), did))
            else:
                if "data_renovacao" in f or "data_vencimento" in f:   # cadastro com datas (importação antiga / API)
                    campos["data_renovacao"] = importer.data_iso(f.get("data_renovacao")) or ""
                    campos["data_vencimento"] = importer.data_iso(f.get("data_vencimento")) or ""
                did = con.execute(f"INSERT INTO doc_documentos({', '.join(campos)}) VALUES ({', '.join('?' * len(campos))})",
                                  tuple(campos.values())).lastrowid
            # vencimento acompanha a periodicidade: última renovação + meses
            doc = con.execute("SELECT * FROM doc_documentos WHERE id=?", (did,)).fetchone()
            if "periodicidade_meses" in campos and doc["data_renovacao"] and doc["periodicidade_meses"]:
                con.execute("UPDATE doc_documentos SET data_vencimento=? WHERE id=?", (somar_meses(doc["data_renovacao"], doc["periodicidade_meses"]), did))
                con.execute("UPDATE doc_anexos SET data_vencimento=? WHERE documento_id=? AND data_renovacao=?",
                            (somar_meses(doc["data_renovacao"], doc["periodicidade_meses"]), did, doc["data_renovacao"]))
            if arq and arq.filename:
                salvar_arquivo(con, did, arq, doc["data_renovacao"], doc["data_vencimento"], "Primeiro anexo")
        return jsonify(ok=True, id=did)

    @app.post("/api/docs/<int:did>/renovacoes")
    @guarda
    def docs_renovar(did):
        """Nova linha na lista de renovações: data (obrigatória), vencimento (vazio = data + periodicidade), arquivo e observação
        opcionais. A renovação mais recente vira a data do documento e tira a marca de "em processo"."""
        f = request.form
        ren = importer.data_iso(f.get("data_renovacao")) or ""
        if not ren:
            abort(400, "Informe a data da renovação.")
        with db.connect() as con:
            visao.exigir_doc(con, did)
            doc = con.execute("SELECT * FROM doc_documentos WHERE id=?", (did,)).fetchone()
            if not doc:
                abort(404)
            venc = importer.data_iso(f.get("data_vencimento")) or somar_meses(ren, doc["periodicidade_meses"])
            arq = request.files.get("arquivo")
            if arq and arq.filename:
                salvar_arquivo(con, did, arq, ren, venc, importer.txt(f.get("observacao")))
            else:
                con.execute("INSERT INTO doc_anexos(documento_id, arquivo, nome_original, tamanho, data_renovacao, data_vencimento, observacao, enviado_por) "
                            "VALUES (?,?,?,?,?,?,?,?)", (did, "", "", 0, ren, venc, importer.txt(f.get("observacao")), quem()))
            con.execute("UPDATE doc_documentos SET em_processo=0, arquivado=0 WHERE id=?", (did,))
            recalcular(con, did)
        return jsonify(ok=True, vencimento=venc)

    @app.post("/api/docs/<int:did>/anexos")
    @guarda
    def docs_novo_anexo(did):
        """Novo arquivo no histórico. Se for renovação, também atualiza as datas do documento."""
        f = request.form
        arq = request.files.get("arquivo")
        if not arq or not arq.filename:
            abort(400, "Escolha o arquivo.")
        renovacao = f.get("renovacao") in ("1", "true", "on")
        ren = importer.data_iso(f.get("data_renovacao")) or ""
        venc = importer.data_iso(f.get("data_vencimento")) or ""
        if renovacao and not venc:
            abort(400, "Informe a nova data de vencimento.")
        with db.connect() as con:
            visao.exigir_doc(con, did)
            doc = con.execute("SELECT * FROM doc_documentos WHERE id=?", (did,)).fetchone()
            if not doc:
                abort(404)
            if not renovacao:
                ren, venc = doc["data_renovacao"], doc["data_vencimento"]
            salvar_arquivo(con, did, arq, ren, venc, importer.txt(f.get("observacao")))
            if renovacao:
                con.execute("UPDATE doc_documentos SET data_renovacao=?, data_vencimento=?, arquivado=0, "
                            "atualizado_em=datetime('now','localtime') WHERE id=?", (ren or dt.date.today().isoformat(), venc, did))
        return jsonify(ok=True)

    @app.get("/api/docs/anexos/<int:aid>")
    @guarda
    def docs_baixar(aid):
        with db.connect() as con:
            a = con.execute("SELECT * FROM doc_anexos WHERE id=?", (aid,)).fetchone()
            if a:
                visao.exigir_doc(con, a["documento_id"])
        if not a or not a["arquivo"] or not (DOCS_DIR / a["arquivo"]).exists():
            abort(404, "Arquivo não encontrado.")
        return seguranca.enviar_anexo(DOCS_DIR / a["arquivo"], a["nome_original"], baixar=request.args.get("baixar") == "1")

    @app.delete("/api/docs/anexos/<int:aid>")
    @guarda
    def docs_excluir_anexo(aid):
        with db.connect() as con:
            a = con.execute("SELECT * FROM doc_anexos WHERE id=?", (aid,)).fetchone()
            if not a:
                abort(404)
            visao.exigir_doc(con, a["documento_id"])
            con.execute("DELETE FROM doc_anexos WHERE id=?", (aid,))
            if a["data_renovacao"]:
                recalcular(con, a["documento_id"])
        if a["arquivo"]:
            lixeira.guardar(DOCS_DIR / a["arquivo"])
        return jsonify(ok=True)

    @app.delete("/api/docs/<int:did>")
    @guarda
    def docs_excluir(did):
        with db.connect() as con:
            visao.exigir_doc(con, did)
            arqs = [r["arquivo"] for r in con.execute("SELECT arquivo FROM doc_anexos WHERE documento_id=?", (did,))]
            con.execute("DELETE FROM doc_anexos WHERE documento_id=?", (did,))
            con.execute("DELETE FROM doc_documentos WHERE id=?", (did,))
        for a in arqs:
            if a:
                lixeira.guardar(DOCS_DIR / a)
        return jsonify(ok=True)
