"""Perfil: foto de cada pessoa e solicitações de acesso (login pedido na landing, módulos pedidos no perfil)."""
import json
import os
import re

from flask import abort, jsonify, request, send_file

import db
import importer
import seguranca

FOTOS_DIR = db.DATA_DIR / "fotos"
FOTO_MAX = 512 * 1024          # o navegador já reduz para 256x256 antes de enviar
LIMITE_POR_IP = 5              # pedidos de login por hora
LIMITE_PENDENTES = 20          # pedidos de login aguardando: o IP pode ser forjado atrás de túnel


def foto_url(chave):
    """Endereço da foto (ou None). A data do arquivo na URL faz o navegador pegar a foto nova."""
    if not chave:
        return None
    try:
        return f"/api/perfil/foto/{chave}?v={int((FOTOS_DIR / f'{chave}.jpg').stat().st_mtime)}"
    except OSError:
        return None


def pendentes(con):
    return con.execute("SELECT COUNT(*) FROM solicitacoes WHERE situacao='pendente'").fetchone()[0]


def fechar_login(con, sid, por):
    """Marca o pedido de login como aprovado ao criar a conta (mesma transação: se falhar, a conta não fica criada)."""
    cur = con.execute("UPDATE solicitacoes SET situacao='aprovada', resolvido_em=datetime('now','localtime'), resolvido_por=? "
                      "WHERE id=? AND tipo='login' AND situacao='pendente'", (por, sid))
    if not cur.rowcount:
        abort(409, "Este pedido já foi resolvido.")


def _linha(r):
    d = dict(r)
    d.pop("ip", None)
    d["modulos"] = json.loads(d.get("modulos") or "[]")
    return d


def registrar_rotas(app, guarda_admin, registrar, quem, usuario_logado, chave_foto, logado, guias):
    def corpo():
        return request.get_json(silent=True) or {}

    def _texto(d, campo, limite, rotulo):
        v = importer.txt(d.get(campo))
        if len(v) > limite:
            abort(400, f"{rotulo}: use no máximo {limite} caracteres.")
        return v

    def _modulos(d):
        return [g for g in dict.fromkeys(d.get("modulos") or []) if g in guias]

    # ---- foto
    @app.get("/api/perfil/foto/<chave>")
    def perfil_ver_foto(chave):
        if not logado():
            return jsonify(erro="Entre com sua conta primeiro."), 401
        if not re.fullmatch(r"\d+|local", chave):
            abort(404, "Foto não encontrada.")
        caminho = FOTOS_DIR / f"{chave}.jpg"
        if not caminho.exists():
            abort(404, "Foto não encontrada.")
        return send_file(caminho, mimetype="image/jpeg")

    @app.post("/api/perfil/foto")
    def perfil_salvar_foto():
        chave = chave_foto()
        if not chave:
            return jsonify(erro="Entre com sua conta primeiro."), 401
        if (request.content_length or 0) > FOTO_MAX:
            abort(400, "A foto ficou grande demais. Tente outra imagem.")
        dados = request.get_data()
        if len(dados) > FOTO_MAX or not dados.startswith(b"\xff\xd8\xff"):
            abort(400, "Envie uma imagem JPEG de até 512 KB.")
        FOTOS_DIR.mkdir(exist_ok=True)
        tmp = FOTOS_DIR / f"{chave}.tmp"
        tmp.write_bytes(dados)
        os.replace(tmp, FOTOS_DIR / f"{chave}.jpg")
        registrar("trocou a foto do perfil")
        return jsonify(ok=True, foto=foto_url(chave))

    @app.delete("/api/perfil/foto")
    def perfil_remover_foto():
        chave = chave_foto()
        if not chave:
            return jsonify(erro="Entre com sua conta primeiro."), 401
        (FOTOS_DIR / f"{chave}.jpg").unlink(missing_ok=True)
        registrar("removeu a foto do perfil")
        return jsonify(ok=True)

    # ---- solicitações
    @app.post("/api/solicitacoes/login")
    def solicitar_login():
        """Público: quem ainda não tem conta pede o acesso na landing."""
        d = corpo()
        nome, contato = _texto(d, "nome", 120, "Nome"), _texto(d, "contato", 120, "Contato")
        motivo, modulos = _texto(d, "motivo", 500, "Motivo"), _modulos(d)
        if not nome or not contato:
            abort(400, "Informe seu nome e um contato.")
        if not modulos:
            abort(400, "Marque pelo menos um módulo.")
        ip = seguranca.ip_cliente()
        with db.connect() as con:
            # pedido repetido recebe a mesma resposta, sem revelar que o contato já pediu
            if con.execute("SELECT 1 FROM solicitacoes WHERE tipo='login' AND situacao='pendente' AND lower(contato)=lower(?)",
                           (contato,)).fetchone():
                return jsonify(ok=True)
            n_ip = con.execute("SELECT COUNT(*) FROM solicitacoes WHERE tipo='login' AND ip=? "
                               "AND criado_em >= datetime('now','localtime','-1 hour')", (ip,)).fetchone()[0]
            n_pend = con.execute("SELECT COUNT(*) FROM solicitacoes WHERE tipo='login' AND situacao='pendente'").fetchone()[0]
            if n_ip >= LIMITE_POR_IP or n_pend >= LIMITE_PENDENTES:
                return jsonify(erro="Muitos pedidos no momento. Tente de novo mais tarde ou fale com o administrador."), 429
            con.execute("INSERT INTO solicitacoes(tipo, nome, contato, modulos, motivo, ip) VALUES ('login',?,?,?,?,?)",
                        (nome, contato, json.dumps(modulos), motivo, ip))
        return jsonify(ok=True)

    @app.post("/api/solicitacoes/modulo")
    def solicitar_modulo():
        u = usuario_logado()
        if not u:
            return jsonify(erro="Entre com sua conta primeiro."), 401
        if u["perfil"] == "admin":
            abort(400, "O administrador já tem acesso a todos os módulos.")
        d = corpo()
        motivo = _texto(d, "motivo", 500, "Motivo")
        with db.connect() as con:
            ja = set(json.loads(u["acessos"] or "[]"))
            for r in con.execute("SELECT modulos FROM solicitacoes WHERE tipo='modulo' AND usuario_id=? AND situacao='pendente'", (u["id"],)):
                ja.update(json.loads(r["modulos"] or "[]"))
            novos = [g for g in _modulos(d) if g not in ja]
            if not novos:
                abort(400, "Marque pelo menos um módulo que você ainda não tem nem pediu.")
            con.execute("INSERT INTO solicitacoes(tipo, usuario_id, nome, modulos, motivo) VALUES ('modulo',?,?,?,?)",
                        (u["id"], u["nome"], json.dumps(novos), motivo))
        registrar("pediu acesso a módulos", ", ".join(guias[g] for g in novos))
        return jsonify(ok=True)

    @app.get("/api/solicitacoes/minhas")
    def minhas_solicitacoes():
        u = usuario_logado()
        if not u:
            return jsonify(erro="Entre com sua conta primeiro."), 401
        with db.connect() as con:
            return jsonify([_linha(r) for r in con.execute(
                "SELECT * FROM solicitacoes WHERE tipo='modulo' AND usuario_id=? ORDER BY id DESC LIMIT 50", (u["id"],))])

    @app.get("/api/solicitacoes")
    @guarda_admin
    def listar_solicitacoes():
        with db.connect() as con:
            return jsonify([_linha(r) for r in con.execute(
                "SELECT * FROM solicitacoes ORDER BY situacao<>'pendente', id DESC LIMIT 200")])

    @app.get("/api/solicitacoes/pendentes")
    @guarda_admin
    def contar_pendentes():
        with db.connect() as con:
            return jsonify(pendentes=pendentes(con))

    def _resolver(con, sid, situacao):
        return con.execute("UPDATE solicitacoes SET situacao=?, resolvido_em=datetime('now','localtime'), resolvido_por=? "
                           "WHERE id=? AND situacao='pendente'", (situacao, quem(), sid)).rowcount

    @app.post("/api/solicitacoes/<int:sid>/aprovar")
    @guarda_admin
    def aprovar_solicitacao(sid):
        """Só pedido de módulo: o de login é aprovado ao criar a conta (POST /api/usuarios com solicitacao_id)."""
        with db.connect() as con:
            s = con.execute("SELECT * FROM solicitacoes WHERE id=? AND tipo='modulo'", (sid,)).fetchone()
            if not s:
                abort(404, "Pedido não encontrado.")
            u = con.execute("SELECT nome, acessos FROM usuarios WHERE id=? AND ativo=1", (s["usuario_id"],)).fetchone()
            if not u:
                abort(409, "A conta que fez o pedido não está mais ativa.")
            if not _resolver(con, sid, "aprovada"):
                abort(409, "Este pedido já foi resolvido.")
            atuais = json.loads(u["acessos"] or "[]")
            novos = [g for g in json.loads(s["modulos"]) if g not in atuais]
            con.execute("UPDATE usuarios SET acessos=? WHERE id=?", (json.dumps(atuais + novos), s["usuario_id"]))
        registrar(f"aprovou o acesso de {u['nome']}", ", ".join(guias.get(g, g) for g in novos))
        return jsonify(ok=True)

    @app.post("/api/solicitacoes/<int:sid>/recusar")
    @guarda_admin
    def recusar_solicitacao(sid):
        with db.connect() as con:
            s = con.execute("SELECT nome, tipo FROM solicitacoes WHERE id=?", (sid,)).fetchone()
            if not s:
                abort(404, "Pedido não encontrado.")
            if not _resolver(con, sid, "recusada"):
                abort(409, "Este pedido já foi resolvido.")
        registrar(f"recusou o pedido de {s['nome']}", s["tipo"])
        return jsonify(ok=True)
