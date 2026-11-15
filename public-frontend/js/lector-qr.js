// Lector de códigos QR con la cámara, hecho a mano para que funcione bien en
// iPhone. La librería anterior (html5-qrcode) abría la cámara en Safari pero
// nunca reconocía el código aunque se viera perfecto.
//
// Cómo funciona: muestra la cámara en un <video>, y unas 8 veces por segundo
// toma el cuadro visible (el centro de la imagen), lo reduce a 640 px y lo
// pasa por el lector:
//  - BarcodeDetector, el lector integrado del navegador (Chrome/Android), o
//  - jsQR, una librería pequeña que funciona en cualquier navegador, iPhone
//    incluido.
// Se usa igual que antes: new LectorQR('idDelContenedor'), luego
// .start(camara, opciones, alLeer) y .stop().
(function(){
  function LectorQR(idContenedor){
    this.contenedor = document.getElementById(idContenedor);
    this.video = null;
    this.stream = null;
    this.activo = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.detector = null;
    if('BarcodeDetector' in window){
      try { this.detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch(e){ this.detector = null; }
    }
  }

  LectorQR.prototype.start = async function(camara, _opciones, alLeer){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      throw new Error('Este navegador no permite usar la cámara');
    }
    if(!this.detector && typeof window.jsQR !== 'function'){
      throw new Error('No se pudo cargar el lector de QR, revisa tu internet');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: (camara && camara.facingMode) || 'environment', width: { ideal: 1280 }, height: { ideal: 1280 } }
    });
    var v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.muted = true;
    v.autoplay = true;
    v.srcObject = this.stream;
    this.contenedor.innerHTML = '';
    this.contenedor.appendChild(v);
    this.video = v;
    await v.play().catch(function(){});
    this.activo = true;
    this.alLeer = alLeer;
    this._ciclo();
  };

  LectorQR.prototype._ciclo = function(){
    var self = this;
    if(!self.activo) return;
    setTimeout(async function(){
      if(!self.activo) return;
      try {
        var texto = await self._leerCuadro();
        if(texto && self.activo && self.alLeer){ self.alLeer(texto); }
      } catch(e){ /* cuadro sin código: seguir intentando */ }
      self._ciclo();
    }, 120);
  };

  LectorQR.prototype._leerCuadro = async function(){
    var v = this.video;
    if(!v || v.readyState < 2 || !v.videoWidth) return null;
    // Solo el cuadrado central: es lo que se ve en pantalla.
    var lado = Math.min(v.videoWidth, v.videoHeight);
    var sx = (v.videoWidth - lado) / 2;
    var sy = (v.videoHeight - lado) / 2;
    var destino = Math.min(640, lado);
    this.canvas.width = destino;
    this.canvas.height = destino;
    this.ctx.drawImage(v, sx, sy, lado, lado, 0, 0, destino, destino);
    if(this.detector){
      var codigos = await this.detector.detect(this.canvas);
      if(codigos && codigos.length) return codigos[0].rawValue;
      if(typeof window.jsQR !== 'function') return null;
    }
    var img = this.ctx.getImageData(0, 0, destino, destino);
    var r = window.jsQR(img.data, destino, destino, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
  };

  LectorQR.prototype.stop = async function(){
    this.activo = false;
    if(this.stream){ this.stream.getTracks().forEach(function(t){ t.stop(); }); }
    this.stream = null;
    if(this.video){ this.video.srcObject = null; }
    if(this.contenedor){ this.contenedor.innerHTML = ''; }
    this.video = null;
  };

  window.LectorQR = LectorQR;
})();
