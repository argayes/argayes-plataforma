// Cobro automático de la suscripción mensual ($800 MXN/mes) con Stripe.
// Reemplaza lo que antes era "ARGAYES revisa una transferencia bancaria y
// activa la cuenta a mano": el negocio paga con tarjeta en una página de
// Stripe, y de ahí en adelante Stripe cobra solo cada mes y nos avisa por
// webhook si el cobro falla, para desactivar el acceso automáticamente.
const Stripe = require('stripe');

function cliente() {
      if (!process.env.STRIPE_SECRET_KEY) return null;
      return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// true si Stripe está configurado (llave + precio) — si falta algo, las
// rutas de pago responden con un error claro en vez de tronar feo.
function listo() {
      return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

// Manda al negocio a la página de pago de Stripe para que active (o
// reactive) su suscripción. Si la empresa ya tiene un "customer" de Stripe
// de antes, se reusa (para que Stripe no vea cada reintento como un cliente
// nuevo); si no, Stripe lo crea solo al completar el pago, usando el email
// del negocio para que quede ligado.
async function crearSesionCheckout(empresa, urlBase) {
      const stripe = cliente();
      if (!stripe) throw new Error('Stripe no está configurado (falta STRIPE_SECRET_KEY).');
      if (!process.env.STRIPE_PRICE_ID) throw new Error('Falta STRIPE_PRICE_ID en las variables de entorno.');

      const sesion = await stripe.checkout.sessions.create({
              mode: 'subscription',
              line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
              customer: empresa.stripeCustomerId || undefined,
              customer_email: empresa.stripeCustomerId ? undefined : (empresa.email || undefined),
              client_reference_id: empresa.id,
              // Así el webhook sabe a qué negocio de ARGAYES corresponde este
              // pago sin tener que adivinar por el email (que podría repetirse
              // o cambiar).
              subscription_data: { metadata: { empresaId: empresa.id } },
              metadata: { empresaId: empresa.id },
              success_url: `${urlBase}/panel.html?pago=exito`,
              cancel_url: `${urlBase}/panel.html?pago=cancelado`
      });
      return sesion.url;
}

// Portal de Stripe para que el negocio cambie su tarjeta, vea sus recibos o
// cancele — sin que ARGAYES tenga que construir nada de eso a mano.
async function crearSesionPortal(empresa, urlBase) {
      const stripe = cliente();
      if (!stripe) throw new Error('Stripe no está configurado (falta STRIPE_SECRET_KEY).');
      if (!empresa.stripeCustomerId) throw new Error('Esta empresa todavía no tiene una suscripción de Stripe.');
      const sesion = await stripe.billingPortal.sessions.create({
              customer: empresa.stripeCustomerId,
              return_url: `${urlBase}/panel.html`
      });
      return sesion.url;
}

// Convierte el estado que da Stripe en el booleano simple "activa" que ya
// usa todo el resto del backend (requireEmpresaActiva, el login, etc.) —
// "active" y "trialing" dejan pasar; cualquier otro (past_due, canceled,
// unpaid, incomplete_expired...) bloquea el panel hasta que se resuelva.
function activaSegunEstado(estado) {
      return estado === 'active' || estado === 'trialing';
}

// Verifica la firma del webhook (así nadie puede mandarnos un POST fingido
// diciendo "ya pagó" sin de verdad haber pagado) y aplica el cambio en la
// base de datos. db se recibe por parámetro en vez de hacer require('./db')
// aquí arriba, para no crear una dependencia circular si algún día db.js
// necesita algo de este archivo.
async function manejarWebhook(db, rawBody, firma) {
      const stripe = cliente();
      if (!stripe) throw new Error('Stripe no está configurado.');
      if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Falta STRIPE_WEBHOOK_SECRET.');

      const evento = stripe.webhooks.constructEvent(rawBody, firma, process.env.STRIPE_WEBHOOK_SECRET);

      switch (evento.type) {
              // Primer pago exitoso: aquí es cuando por fin existe un
              // "customer" de Stripe ligado a este negocio — lo guardamos.
              case 'checkout.session.completed': {
                      const sesion = evento.data.object;
                      const empresaId = sesion.client_reference_id || sesion.metadata?.empresaId;
                      if (empresaId && sesion.customer) {
                              await db.guardarStripeCustomerId(empresaId, sesion.customer);
                      }
                      break;
              }
              // Se dispara en cada cobro mensual y cada vez que cambia el
              // estado (pago exitoso, pago fallido, cancelación, etc.) — es
              // la fuente de verdad real de si la suscripción sigue activa.
              case 'customer.subscription.created':
              case 'customer.subscription.updated':
              case 'customer.subscription.deleted': {
                      const sub = evento.data.object;
                      await db.sincronizarSuscripcion(sub.customer, {
                              subscriptionId: sub.id,
                              estado: sub.status,
                              activa: activaSegunEstado(sub.status),
                              // "evento.created" es cuando Stripe generó ESTE evento, no
                              // cuando llegó aquí — así un reintento tardío de un evento
                              // viejo no puede pisar un estado más reciente (ver
                              // db.sincronizarSuscripcion).
                              eventoTs: evento.created
                      });
                      break;
              }
              default:
                      // El resto de eventos (facturas, disputas, etc.) no nos
                      // interesan todavía — Stripe los manda igual a todos los
                      // webhooks suscritos a "todos los eventos".
                      break;
      }

      return evento;
}

module.exports = { listo, crearSesionCheckout, crearSesionPortal, manejarWebhook };
