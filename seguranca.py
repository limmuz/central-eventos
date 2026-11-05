"""Proteções comuns do site: origem dos pedidos, cabeçalhos, limite de login, anexos e registro de auditoria."""
import logging
import os
import threading
import time
import traceback
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

from flask import g, jsonify, request, send_file
from werkzeug.exceptions import HTTPException

BASE = Path(__file__).resolve().parent
# caminho antigo de anexo (planilha): só documentos, nunca nada da pasta do site (banco, chave de sessão, código)
EXT_EXTERNOS = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".doc", ".docx", ".xls", ".xlsx", ".xlsm", ".csv", ".txt", ".eml", ".msg"}
EXT_NA_TELA = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"}   # o resto sempre baixa (HTML e SVG executariam como se fossem o site)

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'")

# ----- log no PC do site (não na pasta de rede): fica mesmo se a pasta de rede cair
PASTA_LOG = Path(os.environ.get("USERPROFILE") or Path.home())
_log = logging.getLogger("central.auditoria")
_log.propagate = False
if not _log.handlers:
    try:
        _h = RotatingFileHandler(PASTA_LOG / "central_auditoria.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
        _h.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
        _log.addHandler(_h)
        _log.setLevel(logging.INFO)
    except OSError:
        _log.addHandler(logging.NullHandler())


def ip_cliente():
    """Atrás de túnel a conexão chega de 127.0.0.1: o endereço real vem no cabeçalho."""
    return (request.headers.get("Cf-Connecting-Ip") or (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
            or request.remote_addr or "")


def auditoria(evento, nivel=logging.INFO):
    # nunca registrar senha nem conteúdo do pedido: só quem, de onde e o quê
    _log.log(nivel, "%s | %s", ip_cliente(), str(evento).replace("\n", " ")[:500])


# ----- anexos
def arquivo_externo(texto):
    """Caminho antigo de anexo gravado no banco -> Path, só se for seguro entregar. Vem de planilha importada: não é confiável."""
    try:
        p = Path(texto or "")
        if not p.is_absolute() or p.suffix.lower() not in EXT_EXTERNOS:
            return None
        real = p.resolve()
        if real == BASE or BASE in real.parents or not real.is_file():
            return None
        return real
    except (OSError, ValueError):
        return None


def enviar_anexo(caminho, nome=None, baixar=False):
    nome = nome or Path(caminho).name
    na_tela = not baixar and Path(nome).suffix.lower() in EXT_NA_TELA and Path(caminho).suffix.lower() in EXT_NA_TELA
    return send_file(caminho, as_attachment=not na_tela, download_name=nome)


# ----- limite de login (na memória: reinicia junto com o servidor, sem escrever na pasta de rede a cada tentativa)
LENTO_MS = 800   # acima disso a resposta fica registrada, para achar o que pesa na pasta de rede
JANELA, BLOQUEIO, MAX_LOGIN, MAX_IP = 15 * 60, 15 * 60, 5, 30
_falhas = {}
_trava = threading.Lock()


def _chaves(login):
    return [("login", (login or "").lower(), MAX_LOGIN), ("ip", ip_cliente(), MAX_IP)]


def login_bloqueado(login):
    agora = time.time()
    with _trava:
        for tipo, valor, _ in _chaves(login):
            r = _falhas.get((tipo, valor))
            if r and r.get("ate", 0) > agora:
                return True
    return False


def login_falhou(login):
    agora = time.time()
    with _trava:
        for tipo, valor, limite in _chaves(login):
            r = _falhas.get((tipo, valor))
            if not r or agora - r["ini"] > JANELA:
                r = {"ini": agora, "n": 0}
            r["n"] += 1
            if r["n"] >= limite:
                r["ate"] = agora + BLOQUEIO
            _falhas[(tipo, valor)] = r
        for k in [k for k, r in _falhas.items() if agora - r["ini"] > JANELA and r.get("ate", 0) < agora]:
            del _falhas[k]


def login_ok(login):
    with _trava:
        _falhas.pop(("login", (login or "").lower()), None)


def _origem_valida():
    """Pedido que altera dados precisa vir das telas do próprio site (bloqueia página maliciosa enviando em nome de quem está logado)."""
    sfs = request.headers.get("Sec-Fetch-Site")
    if sfs in ("same-origin", "none"):
        return True
    origem = request.headers.get("Origin")
    if origem:
        return origem.split("://", 1)[-1].rstrip("/").lower() == (request.host or "").lower()
    return sfs is None   # sem esses cabeçalhos não é um navegador enviando de outro site


def instalar(app, quem):
    app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")

    @app.before_request
    def _marcar_inicio():
        g.inicio = time.perf_counter()

    @app.before_request
    def _conferir_origem():
        if request.method not in ("GET", "HEAD", "OPTIONS") and not _origem_valida():
            auditoria(f"BLOQUEADO origem externa | {request.method} {request.path} | {request.headers.get('Origin')}", logging.WARNING)
            return jsonify(erro="Pedido bloqueado: ele não veio das telas da Central."), 403

    @app.after_request
    def _cabecalhos(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("Content-Security-Policy", CSP)
        if resp.mimetype == "application/json":
            resp.headers["Cache-Control"] = "no-store"
        if request.path.startswith("/api/"):
            ms = round((time.perf_counter() - g.get("inicio", time.perf_counter())) * 1000)
            resp.headers["Server-Timing"] = f"app;dur={ms}"
            if ms >= LENTO_MS:
                auditoria(f"LENTO {ms} ms | {request.method} {request.path}", logging.WARNING)
            eh_arquivo = resp.mimetype not in ("application/json", "text/html") and not request.path.startswith("/api/perfil/foto")
            escrita = request.method not in ("GET", "HEAD", "OPTIONS")
            if escrita or eh_arquivo or resp.status_code in (401, 403):
                try:
                    auditoria(f"{quem()} | {request.method} {request.path} | {resp.status_code}")
                except Exception:
                    pass
        return resp

    @app.errorhandler(Exception)
    def _erro_geral(e):
        if isinstance(e, HTTPException):
            return jsonify(erro=e.description), e.code
        codigo = uuid.uuid4().hex[:8]   # a pessoa vê só o código; o detalhe fica no log
        auditoria(f"ERRO {codigo} | {request.method} {request.path} | {traceback.format_exc()[-400:]}", logging.ERROR)
        _log.error("%s\n%s", codigo, traceback.format_exc())
        return jsonify(erro=f"Erro interno. Avise o administrador com o código {codigo}."), 500
