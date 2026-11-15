// Envío de correos transaccionales (por ahora, solo el código de "olvidé mi
// contraseña" de los negocios). Usa Resend (https://resend.com) por tener
// una API muy simple vía HTTP y un nivel gratuito generoso (100 correos/día).
//
// Para activarlo en Render → Environment, agrega:
//   RESEND_API_KEY   la clave de tu cuenta de Resend (Settings → API Keys)
//   EMAIL_FROM       remitente a mostrar, ej. "ARGAYES <onboarding@resend.dev>"
//                    "onboarding@resend.dev" funciona sin verificar dominio
//                    propio, pero Resend solo deja mandar con ese remitente
//                    al correo con el que te registraste en Resend. Para
//                    poder mandarle el código a CUALQUIER negocio real,
//                    hay que verificar tu propio dominio en Resend (gratis)
//                    y usar un remitente de ese dominio, ej.
//                    "ARGAYES <no-responder@tudominio.com>".
//
// Si todavía no configuras RESEND_API_KEY, el código no se pierde: se
// imprime en los logs del servidor (Render → Logs) para que puedas probar
// el flujo completo antes de contratar el envío de correos de verdad.
// Todo lo que escribe una persona (nombre del negocio, del cliente, la
// recompensa) pasa por aquí antes de meterse en el HTML de un correo. Sin
// esto, un negocio podía poner etiquetas HTML o links en su "nombre" o su
// "recompensa" y hacer que ARGAYES se los mandara por correo a sus clientes
// con apariencia de mensaje oficial.
function esc(texto) {
      return String(texto == null ? '' : texto).replace(/[&<>"']/g, (c) => (
              { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
}
// El asunto no es HTML, pero tampoco debe llevar saltos de línea.
function unaLinea(texto) {
      return String(texto == null ? '' : texto).replace(/[\r\n]+/g, ' ').slice(0, 150);
}

async function enviarCodigoReset(destinatario, codigo, nombreEmpresa) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
              console.log(`[SIN EMAIL CONFIGURADO] Código de recuperación para ${destinatario}: ${codigo}`);
              return;
      }
      const from = process.env.EMAIL_FROM || 'ARGAYES <onboarding@resend.dev>';
      const resp = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                      'Authorization': `Bearer ${apiKey}`,
                      'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                      from,
                      to: destinatario,
                      subject: 'Código para restablecer tu contraseña — ARGAYES',
                      html: `
                            <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto">
                              <h2 style="margin-bottom:4px;color:#2a1c05">ARGAYES</h2>
                              <p>Hola${nombreEmpresa ? ' ' + esc(nombreEmpresa) : ''},</p>
                              <p>Usa este código para crear una nueva contraseña. Vence en 15 minutos:</p>
                              <p style="font-size:28px;font-weight:bold;letter-spacing:4px;background:#f1e3c3;color:#2a1c05;padding:12px 18px;border-radius:8px;display:inline-block">${esc(codigo)}</p>
                              <p style="color:#666;font-size:13px">Si tú no pediste este cambio, ignora este correo — tu contraseña actual sigue funcionando igual.</p>
                            </div>
                      `
              })
      });
      if (!resp.ok) {
              const texto = await resp.text().catch(() => '');
              throw new Error('No se pudo enviar el correo de verificación: ' + texto);
      }
}

// Recordatorio a un cliente que no ha vuelto en un tiempo — lo manda el
// propio negocio desde su panel (botón en "Tus números claros"), no es
// automático todavía. Usa el mismo RESEND_API_KEY/EMAIL_FROM de arriba; si
// no están configurados, igual que con el código de recuperación, solo se
// imprime en los logs para poder probar el flujo sin tener Resend contratado.
async function enviarRecordatorioInactividad(destinatario, nombreCliente, nombreEmpresa, recompensa) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
              console.log(`[SIN EMAIL CONFIGURADO] Recordatorio para ${destinatario} (${nombreCliente}) de parte de ${nombreEmpresa}`);
              return;
      }
      const from = process.env.EMAIL_FROM || 'ARGAYES <onboarding@resend.dev>';
      const lineaRecompensa = recompensa
              ? `<p>Te falta poco para tu recompensa: <b>${esc(recompensa)}</b>.</p>`
              : '';
      const resp = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                      'Authorization': `Bearer ${apiKey}`,
                      'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                      from,
                      to: destinatario,
                      subject: unaLinea(`${nombreEmpresa} te extraña — tu tarjeta de lealtad sigue activa`),
                      html: `
                            <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto">
                              <h2 style="margin-bottom:4px;color:#2a1c05">${esc(nombreEmpresa)}</h2>
                              <p>Hola${nombreCliente ? ' ' + esc(nombreCliente) : ''},</p>
                              <p>Hace tiempo que no te vemos. Tu tarjeta de lealtad con ${esc(nombreEmpresa)} sigue activa con tus puntos guardados.</p>
                              ${lineaRecompensa}
                              <p style="color:#666;font-size:13px">Si ya no quieres recibir estos avisos, dile directamente al negocio.</p>
                            </div>
                      `
              })
      });
      if (!resp.ok) {
              const texto = await resp.text().catch(() => '');
              throw new Error('No se pudo enviar el recordatorio: ' + texto);
      }
}

// Correo con un archivo adjunto — lo usa scripts/respaldo-mensual.js para
// mandarte el respaldo de la base de datos cada mes. "contenidoBase64" es
// el archivo ya codificado en base64 (Resend lo pide así, no el archivo
// crudo). Si RESEND_API_KEY no está configurado, no hay forma de mandarlo
// por correo — tronará con un mensaje claro en vez de fingir que se envió.
async function enviarConAdjunto(destinatario, asunto, textoHtml, nombreArchivo, contenidoBase64) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
              throw new Error('Falta RESEND_API_KEY — no se puede mandar el respaldo por correo sin eso configurado en Render → Environment.');
      }
      const from = process.env.EMAIL_FROM || 'ARGAYES <onboarding@resend.dev>';
      const resp = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                      'Authorization': `Bearer ${apiKey}`,
                      'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                      from,
                      to: destinatario,
                      subject: asunto,
                      html: textoHtml,
                      attachments: [{ filename: nombreArchivo, content: contenidoBase64 }]
              })
      });
      if (!resp.ok) {
              const texto = await resp.text().catch(() => '');
              throw new Error('No se pudo enviar el correo con el respaldo: ' + texto);
      }
}

// Aviso al dueño de la plataforma cuando un negocio nuevo se registra solo
// desde "Crear cuenta" — así no hay que entrar al panel de super-admin cada
// rato nomás para ver si llegó alguien nuevo. Es un aviso, no algo crítico
// para el registro: si falla el envío (o no está configurado el correo de
// aviso), el negocio se registra igual, solo no llega la notificación.
async function enviarAvisoNuevoNegocio(nombreNegocio, emailNegocio) {
      const apiKey = process.env.RESEND_API_KEY;
      const destinatario = process.env.ADMIN_NOTIFY_EMAIL || process.env.BACKUP_EMAIL_TO;
      if (!apiKey || !destinatario) {
              console.log(`[SIN EMAIL CONFIGURADO] Solicitud de cuenta nueva: ${nombreNegocio} (${emailNegocio})`);
              return;
      }
      const from = process.env.EMAIL_FROM || 'ARGAYES <onboarding@resend.dev>';
      const resp = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                      'Authorization': `Bearer ${apiKey}`,
                      'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                      from,
                      to: destinatario,
                      subject: unaLinea(`Nueva solicitud de cuenta — ${nombreNegocio}`),
                      html: `
                            <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto">
                              <h2 style="margin-bottom:4px;color:#2a1c05">ARGAYES</h2>
                              <p>Un negocio nuevo pidió una cuenta:</p>
                              <p><b>${esc(nombreNegocio)}</b><br>${esc(emailNegocio)}</p>
                              <p>Entra al panel de super-admin para revisarla y activarla.</p>
                            </div>
                      `
              })
      });
      if (!resp.ok) {
              const texto = await resp.text().catch(() => '');
              console.error('No se pudo mandar el aviso de cuenta nueva: ' + texto);
      }
}

// Alertas de seguridad del super-admin (entradas e intentos fallidos).
// "lineas" son pares [etiqueta, valor]; todo se escapa.
async function enviarAlertaAdmin(asunto, intro, lineas) {
      const apiKey = process.env.RESEND_API_KEY;
      const destinatario = process.env.ADMIN_NOTIFY_EMAIL || process.env.BACKUP_EMAIL_TO;
      const texto = (lineas || []).map(([k, v]) => `${k}: ${v}`).join(' | ');
      if (!apiKey || !destinatario) {
              console.log(`[SIN EMAIL CONFIGURADO] ${asunto} — ${texto}`);
              return;
      }
      const from = process.env.EMAIL_FROM || 'ARGAYES <onboarding@resend.dev>';
      const filas = (lineas || [])
              .map(([k, v]) => `<tr><td style="color:#666;padding:3px 10px 3px 0">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`)
              .join('');
      const resp = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                      from,
                      to: destinatario,
                      subject: unaLinea(asunto),
                      html: `
                            <div style="font-family:Arial,Helvetica,sans-serif;max-width:460px;margin:0 auto">
                              <h2 style="margin-bottom:4px;color:#2a1c05">ARGAYES · Seguridad</h2>
                              <p>${esc(intro)}</p>
                              <table style="font-size:14px">${filas}</table>
                              <p style="color:#666;font-size:13px;margin-top:16px">Si no fuiste tú, cambia ADMIN_SECRET en Render
                              (Environment) de inmediato: eso cierra todas las sesiones abiertas del super-admin.</p>
                            </div>
                      `
              })
      });
      if (!resp.ok) {
              const t = await resp.text().catch(() => '');
              console.error('No se pudo mandar la alerta de seguridad: ' + t);
      }
}

module.exports = { enviarCodigoReset, enviarRecordatorioInactividad, enviarConAdjunto, enviarAvisoNuevoNegocio, enviarAlertaAdmin };
