'use strict';
/*
 * El cuadro de compartir, para las tres pantallas.
 *
 * Estaba escrito dentro de fotos.html. Al querer lo mismo en documentos y en
 * archivos habia dos caminos: copiarlo dos veces mas, o sacarlo aqui. Copiado
 * tres veces, el dia que cambie el aviso legal o la forma de retirar un enlace
 * hay que acordarse de los tres sitios, y no se acuerda nadie.
 *
 * Es autonomo a proposito: se dibuja su propio cuadro la primera vez que hace
 * falta y trae su propio fetch, asi que una pagina solo tiene que llamar a
 *
 *     Compartir.abrir('documentos', { rel: 'informe.docx', nombre: 'informe.docx' });
 *
 * sin tener que prestarle nada.
 */
(function () {
  var caja = null;
  var token = null;
  var actual = null;

  var TEXTO_CON_FECHA =
    'Quien tenga este enlace ve el fichero sin necesidad de cuenta, y puede '
    + 'reenviarlo. Caduca solo, y puedes retirarlo antes desde aquí.';
  var TEXTO_SIN_FECHA =
    'Quien tenga este enlace ve el fichero sin necesidad de cuenta, y puede '
    + 'reenviarlo. Este NO caduca: seguirá funcionando hasta que lo retires '
    + 'aquí a mano.';

  async function api(ruta, opciones) {
    var res = await fetch(ruta, Object.assign({ credentials: 'same-origin' }, opciones || {}));
    var d = null;
    try { d = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((d && d.error) || ('Error ' + res.status));
    return d;
  }

  function $(id) { return document.getElementById(id); }

  function construir() {
    if (caja) return;
    caja = document.createElement('div');
    caja.className = 'qr-fondo';
    caja.id = 'qr';
    caja.hidden = true;
    caja.innerHTML =
      '<div class="qr-caja">'
      + '<h3>Compartir</h3>'
      + '<p class="qr-nombre" id="qr-nombre"></p>'
      + '<div class="qr-hueco" id="qr-hueco"></div>'
      + '<div class="qr-enlace">'
      +   '<input id="qr-url" type="text" readonly>'
      +   '<button class="mini" id="qr-copiar" type="button">Copiar</button>'
      + '</div>'
      + '<div class="qr-dias">Caduca '
      +   '<select id="qr-plazo">'
      +     '<option value="1">mañana</option>'
      +     '<option value="7" selected>en 7 días</option>'
      +     '<option value="30">en 30 días</option>'
      +     '<option value="90">en 90 días</option>'
      +     '<option value="0">nunca</option>'
      +   '</select>'
      + '</div>'
      + '<p class="qr-aviso" id="qr-aviso"></p>'
      + '<div class="qr-correo">'
      +   '<label for="qr-para">Enviarlo por correo</label>'
      +   '<div class="qr-correo-fila">'
      +     '<input id="qr-para" type="email" placeholder="direccion@ejemplo.com" autocomplete="off">'
      +     '<button class="mini" id="qr-enviar" type="button">Enviar</button>'
      +   '</div>'
      +   '<input id="qr-nota" type="text" maxlength="500" placeholder="Nota para quien lo recibe (opcional)">'
      +   '<p class="qr-correo-estado" id="qr-correo-estado"></p>'
      + '</div>'
      + '<div class="qr-botones">'
      +   '<button class="boton" id="qr-retirar" type="button">Retirar enlace</button>'
      +   '<button class="boton principal" id="qr-cerrar" type="button">Hecho</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(caja);

    $('qr-cerrar').onclick = cerrar;
    caja.onclick = function (e) { if (e.target === caja) cerrar(); };

    $('qr-copiar').onclick = function () {
      var campo = $('qr-url');
      campo.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(campo.value).then(function () {
          $('qr-copiar').textContent = 'Copiado';
          setTimeout(function () { $('qr-copiar').textContent = 'Copiar'; }, 1800);
        }, function () {});
      } else {
        // Sin permiso de portapapeles, queda seleccionado para copiar a mano
        try { document.execCommand('copy'); } catch (e) {}
      }
    };

    $('qr-plazo').onchange = async function () {
      if (!actual || !token) return;
      /* Cambiar el plazo es retirar el de antes y sacar otro: si no, quedarian
         dos enlaces vivos del mismo fichero y retirar uno no serviria de nada. */
      try {
        await api('/api/compartir/' + encodeURIComponent(token), { method: 'DELETE' });
        token = null;
        await pedir(actual.tipo, actual.item, parseInt(this.value, 10));
      } catch (err) { fallo(err.message); }
    };

    /* Enviar el enlace por correo. El remitente no se elige aqui: lo decide
       la lista blanca del servidor, para que una pantalla comprometida no
       pueda mandar correo como cualquiera del dominio. */
    $('qr-enviar').onclick = async function () {
      var para = ($('qr-para').value || '').trim();
      var estado = $('qr-correo-estado');
      if (!para) { estado.textContent = 'Escribe una dirección.'; return; }
      if (!token) { estado.textContent = 'Todavía no hay enlace que enviar.'; return; }

      $('qr-enviar').disabled = true;
      estado.textContent = 'Enviando…';
      try {
        await api('/api/enviar-enlace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, para: para, nota: ($('qr-nota').value || '').trim() }),
        });
        estado.textContent = 'Enviado a ' + para;
        $('qr-para').value = '';
        $('qr-nota').value = '';
      } catch (e) {
        estado.textContent = e.message || 'No se pudo enviar.';
      } finally {
        $('qr-enviar').disabled = false;
      }
    };

    $('qr-retirar').onclick = async function () {
      if (!token) return cerrar();
      try {
        await api('/api/compartir/' + encodeURIComponent(token), { method: 'DELETE' });
        token = null;
        cerrar();
      } catch (err) { fallo(err.message); }
    };

    document.addEventListener('keydown', function (e) {
      if (!caja.hidden && e.key === 'Escape') { cerrar(); e.stopPropagation(); }
    }, true);
  }

  function fallo(mensaje) {
    $('qr-hueco').textContent = '';
    $('qr-aviso').textContent = mensaje;
  }

  async function pedir(tipo, item, dias) {
    $('qr-hueco').textContent = '…';
    var d = await api('/api/compartir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: tipo, f: item.rel, dias: dias }),
    });
    token = d.token;
    $('qr-nombre').textContent = item.nombre;
    /* El SVG lo dibuja la libreria en el servidor a partir de una URL que
       montamos nosotros: no es HTML de nadie de fuera. */
    $('qr-hueco').innerHTML = d.svg;
    $('qr-url').value = d.url;
    $('qr-aviso').textContent = d.caduca === null ? TEXTO_SIN_FECHA : TEXTO_CON_FECHA;
    return d;
  }

  /* Al cerrar se limpia lo tecleado: si no, la proxima vez que se abra el
     cuadro para OTRO fichero seguiria ahi la direccion anterior, y es facil
     darle a enviar sin mirar. */
  function limpiarCorreo() {
    if (!caja) return;
    if ($('qr-para')) $('qr-para').value = '';
    if ($('qr-nota')) $('qr-nota').value = '';
    if ($('qr-correo-estado')) $('qr-correo-estado').textContent = '';
  }

  function cerrar() {
    limpiarCorreo();
    if (caja) caja.hidden = true;
    actual = null;
  }

  window.Compartir = {
    abrir: async function (tipo, item) {
      construir();
      actual = { tipo: tipo, item: item };
      token = null;
      caja.hidden = false;
      $('qr-nombre').textContent = item.nombre;
      $('qr-url').value = '';
      $('qr-aviso').textContent = '';
      try {
        await pedir(tipo, item, parseInt($('qr-plazo').value, 10));
      } catch (err) {
        fallo(err.message);
      }
    },
    cerrar: cerrar,
  };
})();
