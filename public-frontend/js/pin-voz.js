// PIN de la pantalla de cocina y del panel del menú de la recepcionista de IA.
// Agrega el PIN guardado en este dispositivo a las peticiones del tablero; si
// el servidor responde que falta o que es incorrecto (401), muestra una
// ventana para escribirlo y reintenta. El PIN se recuerda en este dispositivo,
// así la tablet de la cocina solo lo pide una vez.
// Se carga ANTES del script de la página.
(function(){
  var m = location.search.match(/[?&]t=([a-z0-9-]{16,64})/i);
  if(!m) return;
  var tablero = m[1].toLowerCase();
  var CLAVE = 'argayes-pin-' + tablero;
  var enMemoria = '';
  function leer(){ try { return localStorage.getItem(CLAVE) || enMemoria; } catch(e){ return enMemoria; } }
  function guardar(p){ enMemoria = p; try { if(p) localStorage.setItem(CLAVE, p); else localStorage.removeItem(CLAVE); } catch(e){} }
  window.ArgayesPin = { leer: leer, guardar: guardar };

  var original = window.fetch.bind(window);
  // Rutas que usa la IA: no llevan PIN.
  function necesitaPin(url){
    var limpio = url.split('?')[0];
    if(limpio.indexOf('/api/voz/' + tablero + '/') < 0) return false;
    return !/\/(pedido|reservacion|consultar|pin)$/.test(limpio);
  }
  function conPin(opts){
    var o = Object.assign({}, opts || {});
    var h = {};
    if(o.headers){ Object.keys(o.headers).forEach(function(k){ h[k] = o.headers[k]; }); }
    var pin = leer();
    if(pin) h['X-Pin'] = pin;
    o.headers = h;
    return o;
  }

  var esperando = null;
  window.fetch = async function(entrada, opts){
    var url = String(entrada && entrada.url || entrada);
    if(!necesitaPin(url)) return original(entrada, opts);
    var r = await original(entrada, conPin(opts));
    if(r.status === 401 || r.status === 429){
      var base = url.slice(0, url.indexOf('/api/voz/'));
      esperando = esperando || pedirPin(base, r.status === 429).finally(function(){ esperando = null; });
      await esperando;
      r = await original(entrada, conPin(opts));
    }
    return r;
  };

  function pedirPin(base, bloqueado){
    return new Promise(function(resolve){
      var fondo = document.createElement('div');
      fondo.setAttribute('role', 'dialog');
      fondo.setAttribute('aria-modal', 'true');
      fondo.setAttribute('aria-labelledby', 'pinTitulo');
      fondo.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,12,16,.55);display:flex;align-items:center;justify-content:center;padding:16px';
      fondo.innerHTML =
        '<form style="background:var(--panel,#fff);color:var(--ink,#16181D);border:1px solid var(--line,#e6e4df);border-radius:18px;padding:24px;width:min(360px,100%);font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,.25)">' +
        '<h2 id="pinTitulo" style="margin:0 0 6px;font-size:19px;font-weight:500">Escribe el PIN</h2>' +
        '<p style="margin:0 0 16px;font-size:14px;color:var(--muted,#6a6e76);line-height:1.5">Esta pantalla tiene datos de clientes. El PIN se queda guardado en este dispositivo.</p>' +
        '<input id="pinCampo" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]*" maxlength="8" aria-label="PIN" style="width:100%;font:inherit;font-size:24px;letter-spacing:.4em;text-align:center;padding:12px;border-radius:12px;border:1px solid var(--line,#e6e4df);background:var(--panel-2,#f5f4f0);color:inherit">' +
        '<p id="pinError" role="alert" style="min-height:20px;margin:10px 0 0;font-size:14px;color:#C2483D"></p>' +
        '<button type="submit" style="width:100%;margin-top:8px;padding:12px;border-radius:999px;border:0;background:var(--accent,#14213D);color:var(--accent-ink,#fff);font:inherit;font-size:15px;cursor:pointer">Entrar</button>' +
        '</form>';
      document.body.appendChild(fondo);
      var form = fondo.querySelector('form'), campo = fondo.querySelector('#pinCampo'), error = fondo.querySelector('#pinError'), boton = fondo.querySelector('button');
      if(bloqueado) error.textContent = 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.';
      setTimeout(function(){ campo.focus(); }, 50);
      form.addEventListener('submit', async function(ev){
        ev.preventDefault();
        var pin = campo.value.replace(/\D/g, '');
        if(pin.length < 4){ error.textContent = 'El PIN tiene de 4 a 8 números.'; return; }
        boton.disabled = true; error.textContent = '';
        try {
          var r = await original(base + '/api/voz/' + tablero + '/restaurante', { headers: { 'X-Pin': pin }, cache: 'no-store' });
          if(r.ok){ guardar(pin); fondo.remove(); resolve(); return; }
          error.textContent = r.status === 429 ? 'Demasiados intentos. Espera 15 minutos.' : 'PIN incorrecto.';
          campo.value = ''; campo.focus();
        } catch(e){
          error.textContent = 'Sin conexión. Revisa tu internet.';
        }
        boton.disabled = false;
      });
    });
  }
})();
