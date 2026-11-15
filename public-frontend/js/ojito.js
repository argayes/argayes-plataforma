// Botón de "ojito" para ver/ocultar lo que se escribe en los campos de
// contraseña. Se agrega solo a todos los <input type="password"> de la página.
(function(){
  var OJO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var OJO_TACHADO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19C5.5 19 2 12 2 12a18 18 0 0 1 4.1-5.1M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>';
  function agregar(input){
    if(input.dataset.ojito) return;
    input.dataset.ojito = '1';
    var envoltura = document.createElement('span');
    envoltura.style.cssText = 'position:relative;display:block;width:100%';
    input.parentNode.insertBefore(envoltura, input);
    envoltura.appendChild(input);
    input.style.paddingRight = '46px';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Mostrar contraseña');
    btn.title = 'Mostrar contraseña';
    btn.innerHTML = OJO;
    btn.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);width:36px;height:36px;' +
      'display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:inherit;opacity:.65;cursor:pointer;padding:0;border-radius:8px';
    btn.addEventListener('click', function(){
      var visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      btn.innerHTML = visible ? OJO : OJO_TACHADO;
      btn.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
      btn.title = btn.getAttribute('aria-label');
      input.focus();
    });
    envoltura.appendChild(btn);
  }
  function todos(){ document.querySelectorAll('input[type="password"]').forEach(agregar); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', todos); else todos();
})();
