"""Central de Engenharia — Engenharia & Infraestrutura (Arena Demo): Relatório de eventos e Notas fiscais.

Rodar em modo desenvolvimento:   python app.py
Rodar para a rede (recomendado): python servidor.py   (ou dê dois cliques em INICIAR_SITE.bat)
"""
import json
import re
import os
import secrets
import uuid
from functools import wraps
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

import calculos
import db
import exporter
import importer

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "config.json"
CONFIG_PADRAO = {
    "porta": 8050,
    "senha_edicao": "",          # senha para editar de OUTROS computadores (vazio = ninguém edita de fora)
    "editar_neste_computador": True,  # quem abre em http://localhost (o PC que roda o site) edita sem senha
    "titulo": "Central de Engenharia",
    "setor": "Engenharia & Infraestrutura",
}


def carregar_config():
    cfg = dict(CONFIG_PADRAO)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    else:
        CONFIG_PATH.write_text(json.dumps(CONFIG_PADRAO, indent=2, ensure_ascii=False), encoding="utf-8")
    chave = BASE / "data" / ".chave_sessao"
    chave.parent.mkdir(exist_ok=True)
    if not chave.exists():
        chave.write_text(secrets.token_hex(32))
    cfg["_secret"] = chave.read_text().strip()
    return cfg


CFG = carregar_config()
app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = CFG["_secret"]
import datetime as _dt
app.permanent_session_lifetime = _dt.timedelta(days=30)
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024  # 300 MB por envio
db.init()


# ----------------------------------------------------------------------------- utilidades
# cabeçalhos que os túneis (ngrok, Cloudflare) e proxies colocam: quem chega por eles NÃO está no PC do site,
# mesmo que a conexão venha de 127.0.0.1 (o programa do túnel roda neste computador)
_CAB_PROXY = ("X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-Ip", "Forwarded",
              "Cf-Connecting-Ip", "Cf-Ray", "Ngrok-Trace-Id", "Ngrok-Skip-Browser-Warning")


def acesso_local():
    if request.remote_addr not in ("127.0.0.1", "::1", "localhost"):
        return False
    if any(request.headers.get(h) for h in _CAB_PROXY):
        return False
    host = (request.host or "").rsplit(":", 1)[0].strip("[]").lower()
    return host in ("localhost", "127.0.0.1", "::1")


def usuario_logado():
    """Conta da equipe logada nesta sessão (ou None). Conta desativada perde o acesso na hora."""
    uid = session.get("uid")
    if not uid:
        return None
    with db.connect() as con:
        u = con.execute("SELECT id, nome, login, perfil, acessos FROM usuarios WHERE id=? AND ativo=1", (uid,)).fetchone()
    return dict(u) if u else None


def pode_editar():
    """Visualização é o padrão. Edita quem está no PC do site, quem entrou com a conta da equipe
    ou (modo antigo) com a senha única do config.json."""
    if session.get("visitante"):          # escolheu "Visitante" na tela inicial: só visualização
        return False
    if CFG.get("editar_neste_computador", True) and acesso_local():
        return True
    if usuario_logado():
        return True
    return bool(CFG.get("senha_edicao")) and session.get("editor") is True


# Guias (áreas) do site. Cada conta da equipe tem acesso às guias marcadas na tela Equipe.
GUIAS = {"relatorio": "Relatório de eventos", "nf": "Notas fiscais", "docs": "Vencimento de documentos", "budget": "Budget",
         "sup": "Suprimentos (consumo)"}


def _lista_acessos(txt):
    try:
        v = json.loads(txt or "[]")
    except ValueError:
        v = []
    return [g for g in v if g in GUIAS]


def acessos():
    """Guias que quem está usando o site pode ver/editar.
    Visitante (ou quem ainda não entrou): só o relatório, em modo visualização.
    PC do site, senha única e administradores: todas. Editor: as marcadas na conta."""
    if session.get("visitante"):
        return ["relatorio"]
    u = usuario_logado()
    if u:
        return list(GUIAS) if u["perfil"] == "admin" else _lista_acessos(u["acessos"])
    if pode_editar():                       # PC do site ou senha única
        return list(GUIAS)
    return ["relatorio"]


def tem_acesso(guia):
    return guia in acessos()


def e_admin():
    """Administra contas: quem está no PC do site ou conta com perfil admin."""
    if session.get("visitante"):
        return False
    if acesso_local():
        return True
    u = usuario_logado()
    return bool(u and u["perfil"] == "admin")


def quem():
    u = usuario_logado()
    if u:
        return u["nome"]
    return "PC do site" if acesso_local() else "senha única"


def registrar(acao, detalhe=""):
    try:
        with db.connect() as con:
            con.execute("INSERT INTO historico(usuario, acao, detalhe) VALUES (?,?,?)", (quem(), acao, detalhe[:500]))
    except Exception:
        pass


ACOES = {"POST": "incluiu", "PUT": "alterou", "DELETE": "excluiu"}


def requer_edicao(f):
    @wraps(f)
    def w(*a, **k):
        if not pode_editar():
            return jsonify(erro="Acesso somente para visualização. Entre com sua conta da equipe para editar."), 403
        if not tem_acesso("relatorio"):
            return jsonify(erro="Sua conta não tem acesso para editar o Relatório de eventos."), 403
        resp = f(*a, **k)
        status = resp[1] if isinstance(resp, tuple) else getattr(resp, "status_code", 200)
        if status < 400:
            arqs = ", ".join(x.filename or "" for x in request.files.getlist("arquivo"))
            registrar(f"{ACOES.get(request.method, request.method)} · {f.__name__.replace('_', ' ')}",
                      f"{request.path}" + (f" · {arqs}" if arqs else ""))
        return resp
    return w


def requer_guia(guia):
    """Rotas de uma guia restrita (ex.: notas fiscais): precisa estar logado e ter a guia liberada.
    Alterações (POST/PUT/DELETE) vão para o histórico."""
    def deco(f):
        @wraps(f)
        def w(*a, **k):
            if not pode_editar() or not tem_acesso(guia):
                return jsonify(erro=f"Sem acesso a {GUIAS[guia]}. Peça ao administrador para liberar na tela Equipe."), 403
            resp = f(*a, **k)
            if request.method in ACOES:
                status = resp[1] if isinstance(resp, tuple) else getattr(resp, "status_code", 200)
                if status < 400:
                    registrar(f"{ACOES[request.method]} · {f.__name__.replace('_', ' ')}", request.path)
            return resp
        return w
    return deco


def requer_admin(f):
    @wraps(f)
    def w(*a, **k):
        if not e_admin():
            return jsonify(erro="Só o administrador pode gerenciar a equipe."), 403
        return f(*a, **k)
    return w


def body():
    return request.get_json(silent=True) or {}


def evento_ou_404(con, eid):
    e = con.execute("SELECT * FROM eventos WHERE id=?", (eid,)).fetchone()
    if not e:
        abort(404)
    return dict(e)


def limpar_evento(d):
    nome = importer.nome_evento(d.get("nome"))
    data = importer.data_iso(d.get("data"))
    if not nome or not data:
        abort(400, "Informe nome e data do evento.")
    pub = d.get("publico")
    return {
        "nome": nome, "data": data,
        "categoria": importer.up(d.get("categoria")),
        "genero": importer.up(d.get("genero")),
        "horario": importer.hora(d.get("horario")),
        "publico": int(importer.num(pub)) if pub not in (None, "") else None,
        "cliente": importer.txt(d.get("cliente")),
        "observacoes": importer.txt(d.get("observacoes")),
    }


@app.errorhandler(413)
def muito_grande(e):
    return jsonify(erro="Arquivo grande demais (limite de 300 MB por envio)."), 413


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(502)
@app.errorhandler(504)
def erro(e):
    return jsonify(erro=getattr(e, "description", str(e))), e.code


# ----------------------------------------------------------------------------- páginas
@app.route("/")
def index():
    return send_from_directory(app.template_folder, "index.html")


@app.route("/api/meta")
def meta():
    with db.connect() as con:
        q = lambda s: [r[0] for r in con.execute(s) if r[0]]
        return jsonify(
            titulo=CFG["titulo"], setor=CFG["setor"],
            editavel=pode_editar(), protegido=bool(CFG.get("senha_edicao")) or _tem_contas(),
            local=acesso_local(), login_logado=bool(usuario_logado()) or session.get("editor") is True,
            acessos=acessos(), guias=GUIAS,
            visitante=bool(session.get("visitante")), entrou_local=bool(session.get("local_ok")) and acesso_local(),
            senha_unica=bool(CFG.get("senha_edicao")),
            usuario=usuario_logado(), admin=e_admin(),
            tem_contas=_tem_contas(),
            categorias=q("SELECT DISTINCT categoria FROM eventos ORDER BY 1"),
            generos=q("SELECT DISTINCT genero FROM eventos ORDER BY 1"),
            tipos_chamado=q("SELECT DISTINCT tipo FROM chamados ORDER BY 1"),
            tipos_item=["AVARIAS", "MDO", "INSUMOS"],
            tipos_relogio=["ÁGUA", "GÁS", "ELÉTRICA", "POÇO", "IRRIGAÇÃO"],
            sla_minutos=calculos.SLA_MINUTOS,
        )


def _tem_contas():
    with db.connect() as con:
        return bool(con.execute("SELECT 1 FROM usuarios WHERE ativo=1 LIMIT 1").fetchone())


@app.post("/api/login")
def login():
    d = body()
    usuario, senha = (d.get("login") or "").strip().lower(), d.get("senha") or ""
    if usuario:
        with db.connect() as con:
            u = con.execute("SELECT * FROM usuarios WHERE login=? AND ativo=1", (usuario,)).fetchone()
            if u and check_password_hash(u["senha_hash"], senha):
                session.clear()
                session.permanent = True
                session["uid"] = u["id"]
                con.execute("UPDATE usuarios SET ultimo_acesso=datetime('now','localtime') WHERE id=?", (u["id"],))
                nome = u["nome"]
            else:
                nome = None
        if nome:
            registrar("entrou no site")
            return jsonify(ok=True, nome=nome)
        return jsonify(erro="Usuário ou senha incorretos."), 401
    # modo antigo: senha única do config.json
    if CFG.get("senha_edicao") and senha == CFG["senha_edicao"]:
        session.permanent = True
        session["editor"] = True
        return jsonify(ok=True)
    return jsonify(erro="Usuário ou senha incorretos."), 401


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.post("/api/visitante")
def entrar_visitante():
    """Tela inicial > Visitante: só visualização (vale até fechar o navegador ou clicar em Sair)."""
    session.clear()
    session["visitante"] = True
    return jsonify(ok=True)


@app.post("/api/entrar-local")
def entrar_local():
    """Tela inicial > Entrar, no próprio PC do site: entra direto como administrador."""
    if not (CFG.get("editar_neste_computador", True) and acesso_local()):
        return jsonify(erro="Entre com seu usuário e senha."), 403
    session.clear()
    session["local_ok"] = True
    return jsonify(ok=True)


@app.post("/api/minha-senha")
def trocar_minha_senha():
    u = usuario_logado()
    if not u:
        return jsonify(erro="Entre com sua conta primeiro."), 401
    d = body()
    nova = d.get("nova") or ""
    if len(nova) < 6:
        return jsonify(erro="A senha precisa ter pelo menos 6 caracteres."), 400
    with db.connect() as con:
        atual = con.execute("SELECT senha_hash FROM usuarios WHERE id=?", (u["id"],)).fetchone()
        if not check_password_hash(atual["senha_hash"], d.get("atual") or ""):
            return jsonify(erro="Senha atual incorreta."), 400
        con.execute("UPDATE usuarios SET senha_hash=? WHERE id=?", (generate_password_hash(nova), u["id"]))
    registrar("trocou a própria senha")
    return jsonify(ok=True)


# ----------------------------------------------------------------------------- equipe (contas)
@app.get("/api/usuarios")
@requer_admin
def listar_usuarios():
    with db.connect() as con:
        return jsonify(db.rows(con.execute(
            "SELECT id, nome, login, perfil, ativo, criado_em, ultimo_acesso, acessos FROM usuarios ORDER BY ativo DESC, nome")))


@app.post("/api/usuarios")
@requer_admin
def salvar_usuario():
    d = body()
    nome = importer.txt(d.get("nome"))
    login_ = re.sub(r"[^a-z0-9._-]", "", (d.get("login") or "").strip().lower())
    perfil = "admin" if d.get("perfil") == "admin" else "editor"
    senha = d.get("senha") or ""
    guias = [g for g in (d.get("acessos") or []) if g in GUIAS]
    if perfil == "admin":
        guias = list(GUIAS)
    if not nome or not login_:
        abort(400, "Informe nome e usuário (sem espaços nem acentos).")
    if not guias:
        abort(400, "Marque pelo menos uma guia que a pessoa pode acessar.")
    acessos_json = json.dumps(guias)
    with db.connect() as con:
        if d.get("id"):
            con.execute("UPDATE usuarios SET nome=?, login=?, perfil=?, ativo=?, acessos=? WHERE id=?",
                        (nome, login_, perfil, 1 if d.get("ativo", True) else 0, acessos_json, d["id"]))
            if senha:
                if len(senha) < 6:
                    abort(400, "A senha precisa ter pelo menos 6 caracteres.")
                con.execute("UPDATE usuarios SET senha_hash=? WHERE id=?", (generate_password_hash(senha), d["id"]))
            acao = f"alterou a conta de {nome}" + (" (nova senha)" if senha else "")
        else:
            if len(senha) < 6:
                abort(400, "A senha precisa ter pelo menos 6 caracteres.")
            if con.execute("SELECT 1 FROM usuarios WHERE login=?", (login_,)).fetchone():
                return jsonify(erro="Já existe uma conta com esse usuário."), 409
            con.execute("INSERT INTO usuarios(nome, login, senha_hash, perfil, acessos) VALUES (?,?,?,?,?)",
                        (nome, login_, generate_password_hash(senha), perfil, acessos_json))
            acao = f"criou a conta de {nome} ({login_})"
    registrar(acao)
    return jsonify(ok=True)


@app.get("/api/historico")
@requer_admin
def listar_historico():
    with db.connect() as con:
        return jsonify(db.rows(con.execute("SELECT * FROM historico ORDER BY id DESC LIMIT 300")))


# ----------------------------------------------------------------------------- eventos
@app.get("/api/eventos")
def listar_eventos():
    with db.connect() as con:
        return jsonify(calculos.eventos_com_totais(con))


@app.get("/api/eventos/<int:eid>")
def detalhe_evento(eid):
    with db.connect() as con:
        evs = calculos.eventos_com_totais(con, "WHERE e.id=?", (eid,))
        if not evs:
            abort(404)
        e = evs[0]
        e["itens"] = db.rows(con.execute(
            "SELECT *, ROUND(valor_unit*qtd,2) AS total FROM itens WHERE evento_id=? ORDER BY tipo, valor_unit*qtd DESC", (eid,)))
        e["relogios_lista"] = db.rows(con.execute("SELECT * FROM relogios WHERE evento_id=? ORDER BY tipo", (eid,)))
        e["energia"] = db.rows(con.execute("SELECT * FROM energia_hora WHERE evento_id=? ORDER BY ordem, id", (eid,)))
        chs = db.rows(con.execute("SELECT * FROM chamados WHERE evento_id=? ORDER BY hora_inicio, id", (eid,)))
        for c in chs:
            c["tempo"] = calculos.minutos(c["hora_inicio"], c["hora_final"])
            c["sla"] = calculos.sla(c["tempo"])
        e["chamados"] = chs
        anexos = db.rows(con.execute("SELECT * FROM anexos WHERE evento_id=? ORDER BY enviado_em DESC", (eid,)))
        for a in anexos:
            a["resumo"] = json.loads(a.pop("resumo_json") or "null")
        e["anexos"] = anexos
        return jsonify(e)


@app.post("/api/eventos")
@requer_edicao
def criar_evento():
    d = limpar_evento(body())
    with db.connect() as con:
        if con.execute("SELECT 1 FROM eventos WHERE nome=? AND data=?", (d["nome"], d["data"])).fetchone():
            return jsonify(erro="Já existe um evento com esse nome nessa data."), 409
        cols = ", ".join(d)
        eid = con.execute(f"INSERT INTO eventos({cols}) VALUES ({', '.join('?' * len(d))})", tuple(d.values())).lastrowid
        return jsonify(id=eid)


@app.put("/api/eventos/<int:eid>")
@requer_edicao
def editar_evento(eid):
    d = limpar_evento(body())
    with db.connect() as con:
        evento_ou_404(con, eid)
        outro = con.execute("SELECT id FROM eventos WHERE nome=? AND data=? AND id<>?", (d["nome"], d["data"], eid)).fetchone()
        if outro:
            return jsonify(erro="Já existe outro evento com esse nome nessa data."), 409
        con.execute(f"UPDATE eventos SET {', '.join(f'{k}=?' for k in d)} WHERE id=?", (*d.values(), eid))
        return jsonify(ok=True)


@app.post("/api/eventos/<int:eid>/duplicar")
@requer_edicao
def duplicar_evento(eid):
    """Cria outro dia do mesmo evento copiando dados cadastrais e itens de MDO (ex.: FESTIVAL DEMO dia 2)."""
    nova_data = importer.data_iso(body().get("data"))
    if not nova_data:
        abort(400, "Informe a nova data.")
    with db.connect() as con:
        e = evento_ou_404(con, eid)
        if con.execute("SELECT 1 FROM eventos WHERE nome=? AND data=?", (e["nome"], nova_data)).fetchone():
            return jsonify(erro="Esse evento já existe nessa data."), 409
        nid = con.execute(
            "INSERT INTO eventos(nome,data,categoria,genero,horario,publico,cliente) VALUES (?,?,?,?,?,?,?)",
            (e["nome"], nova_data, e["categoria"], e["genero"], e["horario"], e["publico"], e["cliente"])).lastrowid
        if body().get("copiar_mdo", True):
            con.execute("INSERT INTO itens(evento_id,tipo,item,valor_unit,qtd) "
                        "SELECT ?,tipo,item,valor_unit,qtd FROM itens WHERE evento_id=? AND tipo='MDO'", (nid, eid))
        return jsonify(id=nid)


@app.delete("/api/eventos/<int:eid>")
@requer_edicao
def excluir_evento(eid):
    with db.connect() as con:
        for a in con.execute("SELECT arquivo FROM anexos WHERE evento_id=?", (eid,)):
            (db.ANEXOS_DIR / a["arquivo"]).unlink(missing_ok=True)
        con.execute("DELETE FROM eventos WHERE id=?", (eid,))
        return jsonify(ok=True)


# ----------------------------------------------------------------------------- itens
@app.post("/api/eventos/<int:eid>/itens")
@requer_edicao
def adicionar_itens(eid):
    lista = body().get("itens") or []
    with db.connect() as con:
        evento_ou_404(con, eid)
        n = 0
        for it in lista:
            nome = importer.up(it.get("item"))
            if not nome:
                continue
            con.execute("INSERT INTO itens(evento_id,tipo,item,valor_unit,qtd) VALUES (?,?,?,?,?)",
                        (eid, importer.tipo_item(it.get("tipo")), nome,
                         importer.num(it.get("valor_unit")), importer.num(it.get("qtd"), 1)))
            n += 1
        return jsonify(inseridos=n)


@app.put("/api/itens/<int:iid>")
@requer_edicao
def editar_item(iid):
    it = body()
    with db.connect() as con:
        con.execute("UPDATE itens SET tipo=?, item=?, valor_unit=?, qtd=? WHERE id=?",
                    (importer.tipo_item(it.get("tipo")), importer.up(it.get("item")),
                     importer.num(it.get("valor_unit")), importer.num(it.get("qtd")), iid))
        return jsonify(ok=True)


@app.delete("/api/itens/<int:iid>")
@requer_edicao
def excluir_item(iid):
    with db.connect() as con:
        con.execute("DELETE FROM itens WHERE id=?", (iid,))
        return jsonify(ok=True)


@app.get("/api/itens")
def listar_itens():
    """Todos os itens com dados do evento (usado na página de Avarias). ?tipo=AVARIAS"""
    tipo = importer.up(request.args.get("tipo"))
    q = ("SELECT i.id, i.evento_id, i.tipo, i.item, i.valor_unit, i.qtd, ROUND(i.valor_unit*i.qtd,2) AS total, "
         "e.nome AS evento, e.data, e.categoria, e.genero FROM itens i JOIN eventos e ON e.id=i.evento_id")
    with db.connect() as con:
        if tipo:
            return jsonify(db.rows(con.execute(q + " WHERE i.tipo=? ORDER BY e.data DESC", (tipo,))))
        return jsonify(db.rows(con.execute(q + " ORDER BY e.data DESC")))


# ----------------------------------------------------------------------------- medidores
@app.put("/api/eventos/<int:eid>/relogios")
@requer_edicao
def salvar_relogios(eid):
    """Recebe {relogios: [{tipo, consumo, valor}, ...]} e grava (substitui por tipo)."""
    with db.connect() as con:
        evento_ou_404(con, eid)
        for r in body().get("relogios") or []:
            tipo = importer.tipo_relogio(r.get("tipo"))
            if r.get("consumo") in (None, "") and r.get("valor") in (None, ""):
                con.execute("DELETE FROM relogios WHERE evento_id=? AND tipo=?", (eid, tipo))
                continue
            consumo, valor = importer.num(r.get("consumo")), importer.num(r.get("valor"))
            if tipo == "IRRIGAÇÃO" and r.get("valor") in (None, "") and consumo:
                # irrigação do gramado sem valor: m³ x custo do m³ da água (Sabesp) do mesmo evento
                ag = next((x for x in body().get("relogios") or [] if importer.tipo_relogio(x.get("tipo")) == "ÁGUA"), None)
                ac, av = (importer.num(ag.get("consumo")), importer.num(ag.get("valor"))) if ag else (0, 0)
                if not ac:
                    row = con.execute("SELECT consumo, valor FROM relogios WHERE evento_id=? AND tipo='ÁGUA'", (eid,)).fetchone()
                    ac, av = (row["consumo"] or 0, row["valor"] or 0) if row else (0, 0)
                if ac and av:
                    valor = round(consumo * av / ac, 2)
            con.execute("INSERT INTO relogios(evento_id,tipo,consumo,valor) VALUES (?,?,?,?) "
                        "ON CONFLICT(evento_id,tipo) DO UPDATE SET consumo=excluded.consumo, valor=excluded.valor",
                        (eid, tipo, consumo, valor))
        return jsonify(ok=True)


@app.put("/api/eventos/<int:eid>/energia")
@requer_edicao
def salvar_energia(eid):
    """Substitui a curva de energia: {linhas: [{hora, consumo, data_consumo}]}."""
    with db.connect() as con:
        evento_ou_404(con, eid)
        con.execute("DELETE FROM energia_hora WHERE evento_id=?", (eid,))
        for i, l in enumerate(body().get("linhas") or [], 1):
            h = importer.hora(l.get("hora"))
            if h:
                con.execute("INSERT INTO energia_hora(evento_id,ordem,data_consumo,hora,consumo) VALUES (?,?,?,?,?)",
                            (eid, i, importer.data_iso(l.get("data_consumo")), h, importer.num(l.get("consumo"))))
        return jsonify(ok=True)


# ----------------------------------------------------------------------------- chamados
@app.get("/api/chamados")
def listar_chamados():
    with db.connect() as con:
        chs = db.rows(con.execute(
            "SELECT c.*, e.nome AS evento, e.data, e.categoria, e.genero FROM chamados c "
            "JOIN eventos e ON e.id=c.evento_id ORDER BY e.data DESC, c.hora_inicio"))
    for c in chs:
        c["tempo"] = calculos.minutos(c["hora_inicio"], c["hora_final"])
        c["sla"] = calculos.sla(c["tempo"])
    return jsonify(chs)


@app.post("/api/eventos/<int:eid>/chamados")
@requer_edicao
def adicionar_chamados(eid):
    with db.connect() as con:
        evento_ou_404(con, eid)
        n = 0
        for c in body().get("chamados") or []:
            if not importer.txt(c.get("descricao")):
                continue
            con.execute("INSERT INTO chamados(evento_id,descricao,tipo,hora_inicio,hora_final) VALUES (?,?,?,?,?)",
                        (eid, importer.up(c.get("descricao")), importer.up(c.get("tipo")),
                         importer.hora(c.get("hora_inicio")), importer.hora(c.get("hora_final"))))
            n += 1
        return jsonify(inseridos=n)


@app.put("/api/chamados/<int:cid>")
@requer_edicao
def editar_chamado(cid):
    c = body()
    with db.connect() as con:
        con.execute("UPDATE chamados SET descricao=?, tipo=?, hora_inicio=?, hora_final=? WHERE id=?",
                    (importer.up(c.get("descricao")), importer.up(c.get("tipo")),
                     importer.hora(c.get("hora_inicio")), importer.hora(c.get("hora_final")), cid))
        return jsonify(ok=True)


@app.delete("/api/chamados/<int:cid>")
@requer_edicao
def excluir_chamado(cid):
    with db.connect() as con:
        con.execute("DELETE FROM chamados WHERE id=?", (cid,))
        return jsonify(ok=True)


# ----------------------------------------------------------------------------- catálogo
@app.get("/api/catalogo")
def listar_catalogo():
    with db.connect() as con:
        return jsonify(db.rows(con.execute("SELECT * FROM catalogo ORDER BY tipo, item")))


@app.post("/api/catalogo")
@requer_edicao
def salvar_catalogo():
    c = body()
    item = importer.up(c.get("item"))
    if not item:
        abort(400, "Informe o item.")
    with db.connect() as con:
        if c.get("id"):
            con.execute("UPDATE catalogo SET tipo=?, item=?, valor_unit=? WHERE id=?",
                        (importer.tipo_item(c.get("tipo")), item, importer.num(c.get("valor_unit")), c["id"]))
        else:
            con.execute("INSERT INTO catalogo(tipo,item,valor_unit) VALUES (?,?,?) "
                        "ON CONFLICT(tipo,item) DO UPDATE SET valor_unit=excluded.valor_unit",
                        (importer.tipo_item(c.get("tipo")), item, importer.num(c.get("valor_unit"))))
        return jsonify(ok=True)


@app.delete("/api/catalogo/<int:cid>")
@requer_edicao
def excluir_catalogo(cid):
    with db.connect() as con:
        con.execute("DELETE FROM catalogo WHERE id=?", (cid,))
        return jsonify(ok=True)


# ----------------------------------------------------------------------------- siglas de área (CHAMADOS CCO)
@app.get("/api/siglas")
def listar_siglas():
    with db.connect() as con:
        return jsonify(db.rows(con.execute("SELECT sigla, tipo FROM siglas_area ORDER BY tipo, sigla")))


@app.post("/api/siglas")
@requer_edicao
def salvar_sigla():
    d = body()
    sigla, tipo = importer.up(d.get("sigla")), importer.up(d.get("tipo"))
    if not sigla or not tipo:
        abort(400, "Informe a sigla e o nome da área.")
    with db.connect() as con:
        antiga = importer.up(d.get("sigla_antiga"))
        if antiga and antiga != sigla:
            con.execute("DELETE FROM siglas_area WHERE sigla=?", (antiga,))
        con.execute("INSERT INTO siglas_area(sigla,tipo) VALUES (?,?) ON CONFLICT(sigla) DO UPDATE SET tipo=excluded.tipo",
                    (sigla, tipo))
        # chamados que ficaram com a sigla crua passam a usar o nome da área
        n = con.execute("UPDATE chamados SET tipo=? WHERE tipo=?", (tipo, sigla)).rowcount
        return jsonify(ok=True, chamados_atualizados=n)


@app.delete("/api/siglas/<sigla>")
@requer_edicao
def excluir_sigla(sigla):
    with db.connect() as con:
        con.execute("DELETE FROM siglas_area WHERE sigla=?", (importer.up(sigla),))
        return jsonify(ok=True)


# ----------------------------------------------------------------------------- anexos
def importer_data_br(iso):
    return "/".join(reversed(iso.split("-"))) if iso else ""


def _salvar_anexo(con, eid, f, puxar=True):
    """Grava o arquivo no evento; se for relatório de custos, já puxa medidores/energia/chamados."""
    nome = f.filename or "arquivo"
    ext = Path(nome).suffix.lower()
    destino = f"{eid}_{uuid.uuid4().hex[:10]}_{secure_filename(nome) or 'arquivo' + ext}"
    caminho = db.ANEXOS_DIR / destino
    f.save(caminho)
    resumo, puxado, avisos, versao = None, {}, [], ""
    if ext in (".xlsx", ".xlsm", ".xls"):
        resumo = importer.resumir_anexo(caminho)
        d = importer.dados_do_anexo(caminho)
        versao = d.get("versao", "")
        if resumo is not None:
            resumo["versao"] = versao
        if puxar:
            ev = con.execute("SELECT nome, data FROM eventos WHERE id=?", (eid,)).fetchone()
            info = d.get("info") or {}
            dono, _ = importer.resolver_evento(con, info.get("evento"), info.get("data"))
            conf = importer.conflito_nome_arquivo(nome, info)
            if conf:
                avisos.append(f"As células C5/C6 da planilha dizem {info.get('evento')} em {importer_data_br(info.get('data'))}, "
                              f"mas o nome do arquivo diz {importer_data_br(conf[1])}. O arquivo foi guardado, mas os "
                              "valores NÃO foram puxados. Corrija C5/C6 na planilha e anexe de novo.")
            elif info.get("data") and info.get("data") != ev["data"] and dono != eid:
                outro = con.execute("SELECT nome, data FROM eventos WHERE id=?", (dono,)).fetchone() if dono else None
                avisos.append(
                    f"Esta planilha é de {info.get('evento')} em {importer_data_br(info.get('data'))}"
                    + (f" (evento {outro['nome']} já cadastrado)" if outro else "")
                    + f", não de {ev['nome']} em {importer_data_br(ev['data'])}. O arquivo foi guardado, "
                      "mas os dados NÃO foram puxados. Exclua e anexe no evento certo (ou use o anexo automático).")
            else:
                puxado = importer.aplicar_dados_anexo(con, eid, d)
            if d["siglas_desconhecidas"]:
                avisos.append("Siglas de área sem cadastro: " + ", ".join(d["siglas_desconhecidas"]) +
                              ". Cadastre em Catálogo › Siglas de área.")
    aid = con.execute(
        "INSERT INTO anexos(evento_id,nome_original,arquivo,tamanho,resumo_json) VALUES (?,?,?,?,?)",
        (eid, nome, destino, caminho.stat().st_size, json.dumps(resumo, ensure_ascii=False, default=str))).lastrowid
    return {"id": aid, "arquivo": nome, "evento_id": eid, "puxado": puxado, "avisos": avisos,
            "versao": versao}


def _importar_se_base(con, f, tmp):
    """Se o arquivo salvo em tmp for a base do Power BI (ou o Excel exportado pelo site),
    importa só o que falta (modo complementar: não duplica nada já cadastrado), apaga o tmp
    e devolve o resultado. Se não for a base, devolve None e deixa o tmp onde está."""
    if not importer.eh_planilha_base(tmp):
        return None
    con.commit()   # a importação usa outra conexão: libera o banco antes
    try:
        res = importer.importar_base(tmp, substituir=False, complementar=True)
        registrar("importar base (complementar)", f"{f.filename}: {res.get('avarias', 0)} avarias, "
                  f"{res.get('mdo', 0)} MDO, {res.get('insumos', 0)} insumos, {res.get('eventos_novos', 0)} eventos novos")
        return {"arquivo": f.filename, "base": True, "resumo": res}
    except Exception as ex:
        return {"arquivo": f.filename, "erro": f"Não consegui ler a planilha base: {ex}"}
    finally:
        tmp.unlink(missing_ok=True)


@app.post("/api/eventos/<int:eid>/anexos")
@requer_edicao
def enviar_anexo(eid):
    arqs = request.files.getlist("arquivo")
    if not arqs:
        abort(400, "Nenhum arquivo enviado.")
    puxar = request.form.get("puxar", "1") == "1"
    with db.connect() as con:
        evento_ou_404(con, eid)
        resultados = []
        for f in arqs:
            tmp = None
            try:
                if Path(f.filename or "").suffix.lower() in (".xlsx", ".xlsm", ".xls"):
                    tmp = db.DATA_DIR / f"_up_{uuid.uuid4().hex}{Path(f.filename).suffix}"
                    f.save(tmp)
                    res_base = _importar_se_base(con, f, tmp)   # soltaram a base do Power BI aqui? completa tudo
                    if res_base:
                        resultados.append(res_base)
                        continue
                    f.stream = open(tmp, "rb")
                resultados.append(_salvar_anexo(con, eid, f, puxar))
            except Exception as ex:  # planilha corrompida, sem permissão na pasta etc.
                resultados.append({"arquivo": f.filename, "erro": f"Não consegui processar: {ex}"})
            finally:
                if tmp is not None:
                    try:
                        f.stream.close()
                    except Exception:
                        pass
                    tmp.unlink(missing_ok=True)
        return jsonify(resultados=resultados)


def _anexar_auto_um(con, f, tmp):
    """Uma planilha de custo por evento (já salva em tmp): descobre o evento pelas células C5/C6 da aba Consumo
    (cria o evento se ainda não existir), anexa e puxa os dados. Devolve o resultado para a tela."""
    res_base = _importar_se_base(con, f, tmp)
    if res_base:
        return res_base
    info = importer.dados_do_anexo(tmp).get("info") or {}
    nome, data = info.get("evento"), info.get("data")
    conf = importer.conflito_nome_arquivo(f.filename, info)
    if conf:
        eid_conf, _ = importer.resolver_evento(con, conf[0], conf[1])
        if not eid_conf:
            tmp.unlink(missing_ok=True)
            return {"arquivo": f.filename, "erro":
                    f"As células C5/C6 dizem {nome} em {importer_data_br(data)}, mas o nome do arquivo diz "
                    f"{importer_data_br(conf[1])}. Corrija C5/C6 na planilha e envie de novo."}
        f.stream = open(tmp, "rb")
        try:
            res = _salvar_anexo(con, eid_conf, f)   # o próprio _salvar_anexo avisa e não puxa
        finally:
            f.stream.close()
            tmp.unlink(missing_ok=True)
        ev = con.execute("SELECT nome, data FROM eventos WHERE id=?", (eid_conf,)).fetchone()
        res.update(evento=ev["nome"], data=ev["data"], criado=False)
        return res
    if not nome or not data:
        tmp.unlink(missing_ok=True)
        return {"arquivo": f.filename, "erro": "Não achei nome (C5) e data (C6) na aba Consumo."}
    eid, como = importer.resolver_evento(con, nome, data)
    criado = False
    if not eid:
        eid = con.execute("INSERT INTO eventos(nome,data) VALUES (?,?)", (nome, data)).lastrowid
        importer.completar_categorias(con)
        criado = True
    f.stream = open(tmp, "rb")
    try:
        res = _salvar_anexo(con, eid, f)
    except Exception as ex:
        return {"arquivo": f.filename, "erro": f"Não consegui processar: {ex}"}
    finally:
        f.stream.close()
        tmp.unlink(missing_ok=True)
    ev = con.execute("SELECT nome FROM eventos WHERE id=?", (eid,)).fetchone()
    res.update(evento=ev["nome"], data=data, criado=criado, como=como, nome_planilha=nome)
    return res


@app.post("/api/anexos/auto")
@requer_edicao
def anexar_automatico():
    """Recebe planilhas de custo por evento (ou a base do Power BI) e anexa / importa cada uma."""
    arqs = request.files.getlist("arquivo")
    if not arqs:
        abort(400, "Nenhum arquivo enviado.")
    resultados = []
    with db.connect() as con:
        for f in arqs:
            tmp = db.DATA_DIR / f"_auto_{uuid.uuid4().hex}{Path(f.filename or 'x.xlsx').suffix}"
            f.save(tmp)
            resultados.append(_anexar_auto_um(con, f, tmp))
    return jsonify(resultados=resultados)


@app.get("/api/anexos/<int:aid>/download")
def baixar_anexo(aid):
    with db.connect() as con:
        a = con.execute("SELECT * FROM anexos WHERE id=?", (aid,)).fetchone()
    if not a:
        abort(404)
    return send_file(db.ANEXOS_DIR / a["arquivo"], as_attachment=True, download_name=a["nome_original"])


@app.get("/api/anexos/<int:aid>/dados")
def dados_anexo(aid):
    """Prévia do que dá para importar do anexo (abas Consumo e CHAMADOS CCO)."""
    with db.connect() as con:
        a = con.execute("SELECT * FROM anexos WHERE id=?", (aid,)).fetchone()
    if not a:
        abort(404)
    return jsonify(importer.dados_do_anexo(db.ANEXOS_DIR / a["arquivo"]))


@app.post("/api/anexos/<int:aid>/aplicar")
@requer_edicao
def aplicar_anexo(aid):
    """Grava no evento os medidores / energia por hora / chamados lidos do anexo (substitui os atuais)."""
    op = body()
    with db.connect() as con:
        a = con.execute("SELECT * FROM anexos WHERE id=?", (aid,)).fetchone()
        if not a:
            abort(404)
        d = importer.dados_do_anexo(db.ANEXOS_DIR / a["arquivo"])
        feito = importer.aplicar_dados_anexo(con, a["evento_id"], d, bool(op.get("relogios")),
                                             bool(op.get("energia")), bool(op.get("chamados")))
        return jsonify(feito)


@app.post("/api/anexos/reorganizar")
@requer_edicao
def reorganizar_anexos():
    """Confere cada planilha anexada: move para o evento certo (pela data/nome da aba Consumo),
    remove anexos repetidos, puxa os dados de novo e apaga eventos duplicados que ficaram vazios."""
    with db.connect() as con:
        return jsonify(importer.reorganizar_anexos(con, db.ANEXOS_DIR))


@app.delete("/api/anexos/<int:aid>")
@requer_edicao
def excluir_anexo(aid):
    with db.connect() as con:
        a = con.execute("SELECT arquivo FROM anexos WHERE id=?", (aid,)).fetchone()
        if a:
            (db.ANEXOS_DIR / a["arquivo"]).unlink(missing_ok=True)
            con.execute("DELETE FROM anexos WHERE id=?", (aid,))
        return jsonify(ok=True)


# ----------------------------------------------------------------------------- importar / exportar
@app.post("/api/importar")
@requer_edicao
def importar():
    f = request.files.get("arquivo")
    if not f:
        abort(400, "Envie a planilha (.xlsm ou .xlsx).")
    tmp = db.DATA_DIR / f"_import_{uuid.uuid4().hex}{Path(f.filename or 'x.xlsx').suffix}"
    f.save(tmp)
    # relatório de custos de um evento (Custos - Engenharia - ....xlsx) no lugar da planilha de importação:
    # anexa no evento e puxa medidores, energia e chamados (como "Enviar planilhas")
    if not importer.eh_planilha_base(tmp) and (importer.dados_do_anexo(tmp).get("info") or {}).get("evento"):
        with db.connect() as con:
            return jsonify(anexos=[_anexar_auto_um(con, f, tmp)])
    try:
        modo = request.form.get("modo") or ("substituir" if request.form.get("substituir", "1") == "1" else "acrescentar")
        res = importer.importar_base(tmp, substituir=modo == "substituir", complementar=modo == "completar")
    except Exception as ex:  # planilha fora do padrão
        return jsonify(erro=f"Não consegui ler a planilha: {ex}"), 400
    finally:
        tmp.unlink(missing_ok=True)
    return jsonify(res)


@app.get("/api/modelo-importacao")
def modelo_importacao():
    """Planilha de importação (exemplo) do Relatório de eventos."""
    return send_file(exporter.gerar_modelo(), as_attachment=True,
                     download_name="PLANILHA DE IMPORTAÇÃO (EXEMPLO) - RELATÓRIO DE EVENTOS.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/api/exportar/relatorio")
def exportar_relatorio():
    """Excel da tela (Visão geral, Evento, Avarias, Manutenção, Comparar): tabelas com filtro + painel com gráficos.
    ?pagina=avarias&ids=1,2,3 (eventos do filtro da tela; vazio = todos)&q=busca&filtros=texto dos filtros"""
    import relatorio_excel
    pagina = request.args.get("pagina") or "visao"
    t = request.args.get("ids")
    ids = {int(x) for x in t.split(",") if x.strip().isdigit()} if t else None
    buf, nome = relatorio_excel.gerar(pagina, ids, request.args.get("q") or "", (request.args.get("filtros") or "")[:600])
    return send_file(buf, as_attachment=True, download_name=f"RELATÓRIO - {nome} - {_dt.date.today():%d-%m-%Y}.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/api/exportar")
def exportar():
    buf = exporter.gerar_excel()
    return send_file(buf, as_attachment=True, download_name="RELATORIO GERAL DE EVENTOS - BASE POWER BI.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


# ----------------------------------------------------------------------------- medições de notas fiscais
import nf  # noqa: E402

nf.registrar_rotas(app, requer_guia("nf"), registrar)

# ----------------------------------------------------------------------------- vencimento de documentos
import docs  # noqa: E402

docs.registrar_rotas(app, requer_guia("docs"), registrar, quem)

# ----------------------------------------------------------------------------- budget, pedidos e realocações
import budget  # noqa: E402

def _guarda_pedidos(f):
    """Pedidos de compra ficam em Notas fiscais: quem tem Notas fiscais OU Budget pode usar."""
    @wraps(f)
    def w(*a, **k):
        if not pode_editar() or not (tem_acesso("nf") or tem_acesso("budget")):
            return jsonify(erro="Sem acesso a Notas fiscais nem a Budget. Peça ao administrador para liberar na tela Equipe."), 403
        resp = f(*a, **k)
        if request.method in ACOES:
            status = resp[1] if isinstance(resp, tuple) else getattr(resp, "status_code", 200)
            if status < 400:
                registrar(f"{ACOES[request.method]} · {f.__name__.replace('_', ' ')}", request.path)
        return resp
    return w


_guarda_pedidos.tem_budget = lambda: tem_acesso("budget")
budget.registrar_rotas(app, requer_guia("budget"), registrar, _guarda_pedidos)

# ----------------------------------------------------------------------------- suprimentos: rateio das contas de consumo
import sup  # noqa: E402

sup.registrar_rotas(app, requer_guia("sup"), registrar)


# ----------------------------------------------------------------------------- planilha única de importação (NF + budget)
import importacao  # noqa: E402


def _pode_importar():
    return pode_editar() and (tem_acesso("nf") or tem_acesso("budget") or tem_acesso("docs"))


@app.get("/api/importacao/modelo")
def importacao_modelo():
    if not _pode_importar():
        return jsonify(erro="Sem acesso a Notas fiscais, Budget ou Documentos."), 403
    with db.connect() as con:
        buf = importacao.gerar_modelo(con, acessos())
    return send_file(buf, as_attachment=True, download_name="PLANILHA DE IMPORTAÇÃO - CENTRAL DE ENGENHARIA.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.post("/api/importacao")
def importacao_importar():
    """Lê qualquer planilha de importação (a única, a EnviarEmailNF antiga ou as antigas do budget) e importa
    as partes que a pessoa tem acesso: LISTAS -> budget (pedidos, budget, realocações) -> notas fiscais."""
    if not _pode_importar():
        return jsonify(erro="Sem acesso a Notas fiscais nem a Budget."), 403
    f = request.files.get("arquivo")
    if not f:
        abort(400, "Envie a planilha.")
    tmp = db.DATA_DIR / f"_imp_{uuid.uuid4().hex}{Path(f.filename or 'x.xlsx').suffix}"
    f.save(tmp)
    res = {"listas": None, "budget": None, "nf": None, "docs": None, "sem_acesso": []}
    try:
        guias = importacao.nomes_guias(tmp)
        tem = lambda nomes: any(any(n in g for n in nomes) for g in guias)
        with db.connect() as con:
            res["listas"] = importacao.importar_listas(con, tmp)
        quer_budget = tem(importacao.GUIAS_BUDGET) or any(g in guias for g in budget.CADASTROS)
        if quer_budget and tem_acesso("budget"):
            with db.connect() as con:
                res["budget"] = budget.importar_excel(con, tmp)
        elif quer_budget:
            res["sem_acesso"].append("Budget (pedidos, budget e realocações)")
        if tem(importacao.GUIAS_NF) and tem_acesso("nf"):
            res["nf"] = nf.importar_planilha(tmp)
        elif tem(importacao.GUIAS_NF):
            res["sem_acesso"].append("Notas fiscais (contratos e medições)")
        if tem(importacao.GUIAS_DOCS) and tem_acesso("docs"):
            with db.connect() as con:
                res["docs"] = docs.importar_planilha(con, tmp)
        elif tem(importacao.GUIAS_DOCS):
            res["sem_acesso"].append("Documentos")
        if not (res["listas"] or res["budget"] or res["nf"] or res["docs"]):
            return jsonify(erro="Não achei nenhuma guia conhecida na planilha (use a planilha de importação do site)."), 400
    except Exception as ex:
        return jsonify(erro=f"Não consegui importar: {ex}"), 400
    finally:
        tmp.unlink(missing_ok=True)
    partes = [k for k in ("listas", "budget", "nf", "docs") if res[k]]
    registrar("importou planilha", f"{f.filename}: {', '.join(partes)}")
    return jsonify(res)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORTA", CFG["porta"])), debug=True)
