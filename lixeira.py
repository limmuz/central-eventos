"""Lixeira: toda exclusão pode ser desfeita pelo administrador durante 90 dias.

Durante um pedido de exclusão, cada conexão ganha gatilhos temporários que anotam o que foi apagado, alterado ou criado,
inclusive o que cai em cascata (itens do evento, linhas do pedido). Desfazer é aplicar essas anotações de trás para frente.
Os gatilhos só existem nesses pedidos: as outras telas não pagam nada por isso, e abrir o banco em outro programa não muda nada.
"""
import json
import logging
import re
import shutil
import sqlite3
import uuid

from flask import abort, g, has_request_context, jsonify, request

import db
import seguranca

PASTA = db.DATA_DIR / "lixeira"
DIAS = 90
FORA = {"lixeira", "lixeira_grupos", "lixeira_arquivos", "historico", "usuarios", "solicitacoes"}
ROTULOS = {
    "eventos": "Evento", "itens": "Item", "relogios": "Medidor", "chamados": "Chamado", "energia_hora": "Energia por hora", "anexos": "Anexo",
    "catalogo": "Item do catálogo", "siglas_area": "Sigla", "nf_medicoes": "Medição", "nf_contratos": "Contrato", "nf_prazos": "Prazo",
    "nf_feriados": "Feriado", "bud_pedidos": "Pedido", "bud_previsto": "Linha do budget", "bud_itens": "Linha do budget", "bud_anos": "Ano do budget",
    "bud_realocacoes": "Realocação", "bud_centros": "Centro de custo", "bud_projetos": "Projeto", "bud_classes": "Classe financeira",
    "doc_documentos": "Documento", "doc_anexos": "Renovação de documento", "sup_meses": "Mês de Suprimentos", "sup_contas": "Conta",
    "sup_linhas": "Linha de rateio", "areas": "Área",
}
CAMPOS_NOME = ("nome", "numero", "item", "sigla", "descricao", "numero_documento", "numero_medicao", "mes", "data", "ano")

SCHEMA = """
CREATE TABLE IF NOT EXISTS lixeira (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo  TEXT NOT NULL,
    tipo   TEXT NOT NULL,          -- D apagou | U alterou | I criou
    tabela TEXT NOT NULL,
    rid    INTEGER NOT NULL,
    dados  TEXT
);
CREATE INDEX IF NOT EXISTS ix_lixeira_grupo ON lixeira(grupo);
CREATE TABLE IF NOT EXISTS lixeira_grupos (
    grupo TEXT PRIMARY KEY, quando TEXT DEFAULT (datetime('now','localtime')), quem TEXT, ip TEXT, rota TEXT, resumo TEXT, itens INTEGER DEFAULT 0,
    restaurado_em TEXT, restaurado_por TEXT
);
CREATE TABLE IF NOT EXISTS lixeira_arquivos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, grupo TEXT NOT NULL, origem TEXT NOT NULL, guardado TEXT NOT NULL
);
"""

_estrutura = None


def _eh_exclusao():
    if request.path.startswith(("/api/lixeira", "/api/perfil/foto")) or not request.path.startswith("/api/"):
        return False
    return request.method == "DELETE" or (request.method == "POST" and request.path.endswith("/excluir"))


def _tabelas(con):
    global _estrutura
    if _estrutura is None:
        nomes = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        _estrutura = {t: [r[1] for r in con.execute(f'PRAGMA table_info("{t}")')] for t in nomes if t not in FORA}
    return _estrutura


def preparar(con):
    """Chamado a cada conexão (db.connect): só faz algo durante um pedido de exclusão."""
    if not has_request_context() or g.get("lixeira_parado") or not _eh_exclusao():
        return
    if "lixeira_grupo" not in g:
        g.lixeira_grupo = uuid.uuid4().hex
    grupo = g.lixeira_grupo
    for t, cols in _tabelas(con).items():
        json_de = lambda lado: "json_object(" + ",".join(f"'{c}',{lado}.\"{c}\"" for c in cols) + ")"
        ins = "INSERT INTO lixeira(grupo,tipo,tabela,rid,dados)"
        con.execute(f"""CREATE TEMP TRIGGER IF NOT EXISTS lx_d_{t} AFTER DELETE ON main."{t}" BEGIN
            {ins} VALUES('{grupo}','D','{t}',OLD.rowid,{json_de('OLD')}); END""")
        con.execute(f"""CREATE TEMP TRIGGER IF NOT EXISTS lx_u_{t} AFTER UPDATE ON main."{t}" BEGIN
            {ins} VALUES('{grupo}','U','{t}',OLD.rowid,{json_de('OLD')}); END""")
        con.execute(f"""CREATE TEMP TRIGGER IF NOT EXISTS lx_i_{t} AFTER INSERT ON main."{t}" BEGIN
            {ins} VALUES('{grupo}','I','{t}',NEW.rowid,NULL); END""")


def guardar(caminho):
    """No lugar de apagar o arquivo: guarda para poder voltar. Fora de uma exclusão registrada, apaga como antes."""
    grupo = g.get("lixeira_grupo") if has_request_context() else None
    try:
        if not caminho.exists():
            return
        if not grupo:
            caminho.unlink(missing_ok=True)
            return
        destino = PASTA / grupo / caminho.name
        destino.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(caminho), str(destino))
        with db.connect() as con:
            con.execute("INSERT INTO lixeira_arquivos(grupo, origem, guardado) VALUES (?,?,?)", (grupo, str(caminho), str(destino)))
    except OSError as e:
        seguranca.auditoria(f"LIXEIRA não guardou {caminho.name}: {e}", logging.WARNING)


def _resumo(linhas):
    apagados = [r for r in linhas if r["tipo"] == "D"]
    if not apagados:
        return "Alteração", 0
    # o primeiro registro principal: pula as tabelas de ligação que caem em cascata
    prioridade = list(ROTULOS)
    principal = min(apagados, key=lambda r: prioridade.index(r["tabela"]) if r["tabela"] in prioridade else 99)
    d = json.loads(principal["dados"] or "{}")
    nome = next((str(d[c]) for c in CAMPOS_NOME if d.get(c) not in (None, "")), "")
    texto = f"{ROTULOS.get(principal['tabela'], principal['tabela'])} {nome}".strip()
    return (texto + (f" + {len(apagados) - 1} registro(s) ligado(s)" if len(apagados) > 1 else "")), len(apagados)


def limpar_antigos(con):
    for r in con.execute(f"SELECT grupo FROM lixeira_grupos WHERE quando < datetime('now','localtime','-{DIAS} days')").fetchall():
        con.execute("DELETE FROM lixeira WHERE grupo=?", (r["grupo"],))
        con.execute("DELETE FROM lixeira_arquivos WHERE grupo=?", (r["grupo"],))
        con.execute("DELETE FROM lixeira_grupos WHERE grupo=?", (r["grupo"],))
        shutil.rmtree(PASTA / r["grupo"], ignore_errors=True)
    con.execute("DELETE FROM lixeira WHERE grupo NOT IN (SELECT grupo FROM lixeira_grupos) AND id < (SELECT COALESCE(MAX(id),0) FROM lixeira)")


def registrar_rotas(app, guarda_admin, registrar, quem, e_admin):
    with db.connect() as con:
        con.executescript(SCHEMA)
        limpar_antigos(con)
    db.ao_conectar = preparar

    @app.after_request
    def _fechar_grupo(resp):
        grupo = g.get("lixeira_grupo")
        if not grupo:
            return resp
        g.lixeira_parado = True
        try:
            with db.connect() as con:
                if resp.status_code >= 400:
                    con.execute("DELETE FROM lixeira WHERE grupo=?", (grupo,))
                    return resp
                linhas = con.execute("SELECT tipo, tabela, dados FROM lixeira WHERE grupo=? ORDER BY id", (grupo,)).fetchall()
                if not linhas:
                    return resp
                resumo, n = _resumo(linhas)
                con.execute("INSERT OR REPLACE INTO lixeira_grupos(grupo, quem, ip, rota, resumo, itens) VALUES (?,?,?,?,?,?)",
                            (grupo, quem(), seguranca.ip_cliente(), f"{request.method} {request.path}", resumo, n))
            if e_admin():
                resp.headers["X-Lixeira"] = grupo
        except sqlite3.Error as e:
            seguranca.auditoria(f"LIXEIRA não registrou {grupo}: {e}", logging.ERROR)
        return resp

    @app.get("/api/lixeira")
    @guarda_admin
    def lixeira_listar():
        with db.connect() as con:
            return jsonify(db.rows(con.execute("""SELECT grupo, quando, quem, ip, resumo, itens, restaurado_em, restaurado_por
                FROM lixeira_grupos ORDER BY restaurado_em IS NOT NULL, quando DESC, rowid DESC LIMIT 300""")))

    @app.post("/api/lixeira/<grupo>/restaurar")
    @guarda_admin
    def lixeira_restaurar(grupo):
        if not re.fullmatch(r"[0-9a-f]{32}", grupo):
            abort(404, "Exclusão não encontrada.")
        con = db.connect()
        try:
            r = con.execute("SELECT * FROM lixeira_grupos WHERE grupo=?", (grupo,)).fetchone()
            if not r:
                abort(404, "Exclusão não encontrada.")
            if r["restaurado_em"]:
                abort(409, "Essa exclusão já foi desfeita.")
            con.execute("BEGIN")
            con.execute("PRAGMA defer_foreign_keys = ON")   # a ordem de volta não precisa respeitar quem depende de quem
            for x in con.execute("SELECT * FROM lixeira WHERE grupo=? ORDER BY id DESC", (grupo,)).fetchall():
                t = x["tabela"]
                if t not in _tabelas(con):
                    continue
                if x["tipo"] == "I":
                    con.execute(f'DELETE FROM "{t}" WHERE rowid=?', (x["rid"],))
                    continue
                d = json.loads(x["dados"])
                colunas = [c for c in d if c in _tabelas(con)[t]]
                if x["tipo"] == "D":
                    nomes = ",".join(f'"{c}"' for c in colunas)
                    con.execute(f'INSERT INTO "{t}"(rowid,{nomes}) VALUES (?{",?" * len(colunas)})', (x["rid"], *(d[c] for c in colunas)))
                else:
                    sets = ",".join(f'"{c}"=?' for c in colunas)
                    con.execute(f'UPDATE "{t}" SET {sets} WHERE rowid=?', (*(d[c] for c in colunas), x["rid"]))
            con.execute("UPDATE lixeira_grupos SET restaurado_em=datetime('now','localtime'), restaurado_por=? WHERE grupo=?", (quem(), grupo))
            arquivos = con.execute("SELECT * FROM lixeira_arquivos WHERE grupo=?", (grupo,)).fetchall()
            con.commit()
        except sqlite3.IntegrityError:
            con.rollback()
            return jsonify(erro="Não deu para restaurar: já existe um registro com o mesmo número ou nome. Exclua ou renomeie o atual e tente de novo."), 409
        finally:
            con.close()
        faltou = 0
        for a in arquivos:
            try:
                shutil.move(a["guardado"], a["origem"])
            except OSError:
                faltou += 1
        registrar("desfez uma exclusão", r["resumo"] or "")
        return jsonify(ok=True, resumo=r["resumo"], arquivos_faltando=faltou)
