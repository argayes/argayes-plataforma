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
                              <p>Hola${nombreEmpresa ? ' ' + nombreEmpresa : ''},</p>
                              <p>Usa este código para crear una nueva contraseña. Vence en 15 minutos:</p>
                              <p style="font-size:28px;font-weight:bold;letter-spacing:4px;background:#f1e3c3;color:#2a1c05;padding:12px 18px;border-radius:8px;display:inline-block">${codigo}</p>
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
              ? `<p>Te falta poco para tu recompensa: <b>${recompensa}</b>.</p>`
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
                      subject: `${nombreEmpresa} te extraña — tu tarjeta de lealtad sigue activa`,
                      html: `
                            <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto">
                              <h2 style="margin-bottom:4px;color:#2a1c05">${nombreEmpresa}</h2>
                              <p>Hola${nombreCliente ? ' ' + nombreCliente : ''},</p>
                              <p>Hace tiempo que no te vemos. Tu tarjeta de lealtad con ${nombreEmpresa} sigue activa con tus puntos guardados.</p>
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

module.exports = { enviarCodigoReset, enviarRecordatorioInactividad };
