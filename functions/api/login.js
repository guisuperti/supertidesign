// POST /api/login { password, code?, form, website, turnstile? } → session cookie
// Order: IP lock → form token (age) → honeypot → Turnstile → password → 2FA code.
// Every refusal looks the same to the client ("Dados incorretos"), except a lock, which says how long.
import {
  audit, checkFormToken, clearFailures, clientInfo, createSession, guardState, registerFailure,
  safeEqual, secretsOk, sessionCookie, totpEnabled, verifyTotp, verifyTurnstile,
} from "../../server/auth.js";
import { fail, json, needBindings, readJson } from "../../server/http.js";

const WRONG = "Senha ou código incorretos.";
const minutes = (s) => Math.max(1, Math.ceil(s / 60));
// Same response time for every failure, so timing doesn't tell a bot which check failed
const slow = () => new Promise((r) => setTimeout(r, 400 + Math.random() * 400));

export async function onRequestPost({ request, env, data }) {
  const missing = needBindings(env, "DB");
  if (missing) return missing;
  if (!secretsOk(env)) return fail(503, "Defina os segredos ADMIN_PASSWORD (12+ caracteres) e SESSION_SECRET (32+ caracteres) no Cloudflare.");
  const { ip } = clientInfo(request);

  const g = await guardState(env, ip);
  if (g.locked) {
    await audit(env, request, "login_blocked", `faltam ${minutes(g.retryIn)} min`);
    return fail(429, `Muitas tentativas. Tente de novo em ${minutes(g.retryIn)} min.`);
  }

  let body;
  try { body = await readJson(request, 10_000); } catch { return fail(400, "Pedido inválido."); }
  const { password = "", code = "", form = "", website = "", turnstile = "" } = body || {};

  const refuse = async (event, detail, weight = 1) => {
    await audit(env, request, event, detail);
    const r = await registerFailure(env, ip, weight);
    await slow();
    if (r.locked) return fail(429, `Muitas tentativas. Tente de novo em ${minutes(r.retryIn)} min.`);
    return fail(401, WRONG);
  };

  // Bots: the hidden "website" field is filled, or the form was posted without/too soon after loading
  if (website) return refuse("honeypot", "campo oculto preenchido", 5);
  const ft = await checkFormToken(env, form);
  if (ft !== "ok") {
    if (ft === "expired") { await slow(); return fail(400, "A página ficou aberta tempo demais. Recarregue e tente de novo."); }
    // Counts as one failure only: without a valid token the password is never checked, so there is
    // nothing to gain by guessing, and a page left open while the secrets changed must not lock anyone out
    await audit(env, request, "honeypot", ft === "too_fast" ? "enviado rápido demais" : "token de formulário ausente ou de outra configuração");
    const r = await registerFailure(env, ip, 1);
    await slow();
    if (r.locked) return fail(429, `Muitas tentativas. Tente de novo em ${minutes(r.retryIn)} min.`);
    return fail(400, "A página do painel está desatualizada. Recarregue (F5) e tente de novo.");
  }
  if (!(await verifyTurnstile(env, turnstile, ip))) return refuse("login_fail", "verificação anti-robô falhou");
  if (!(await safeEqual(password, env.ADMIN_PASSWORD))) return refuse("login_fail", "senha incorreta");
  if (totpEnabled(env) && !(await verifyTotp(env, code))) return refuse("login_fail", "código de 2 fatores incorreto");

  await clearFailures(env, ip);
  const token = await createSession(env, request);
  await audit(env, request, "login_ok", (totpEnabled(env) ? "senha + 2 fatores" : "senha") + (data.accessUser ? " · Access: " + data.accessUser : ""));
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, token) });
}
