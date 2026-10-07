'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   El arbol-QR en galeria, archivos y documentos.

   Es el hermano de arbolqr-ui.js de l-notes y hace lo mismo: un jardin en la
   esquina que, al pulsarlo, sube a ensenar el QR del enlace que toque. El
   motor —arbol3d.js, arbolqr.js y qrcode.js— es el mismo fichero copiado.

   Lo que NO se pudo compartir es este guion, y conviene decir por que: alli
   la ruta sale de `.tree-row.active`, el endpoint es /api/notes/qr/crear y los
   alcances son los de una boveda de notas. Aqui la seccion la dice la
   pantalla, el endpoint es /api/qr/crear y los alcances son otros. Quedaba un
   fichero con dos mitades excluyentes, que es peor que dos ficheros.

   ── Los alcances y los permisos ──────────────────────────────────────────

   Cuatro alcances, en paralelo a l-notes. Como compartir.js solo sabe de
   ficheros sueltos, los tres grandes se resuelven en el servidor a la lista de
   ficheros que contienen (ver lib/alcance.js), asi que el enlace es una foto
   fija: lo que se anada despues a esa carpeta no entra.

   Y tres permisos, que es donde esto se aparta de l-notes:

     Solo ver          enlace publico sin el boton de bajar.
     Ver y descargar   enlace publico con el boton, que es lo de siempre.
     Lectura y escritura   invitacion de EDITOR, y pide cuenta.

   Dos avisos que la pantalla da con todas las letras, porque son verdad:

     · «Solo ver» es un BADEN, no un candado. Para ensenar una foto hay que
       mandarle los bytes al navegador, asi que quien tenga el enlace puede
       guardarla desde el menu o hacerle una captura.
     · La escritura NO se puede acotar. accesos.js no tiene ambito: un acceso
       de editor vale para tus cuatro secciones enteras. Por eso al elegirla se
       vetan los demas alcances, igual que l-notes veta «escritura + subnota».
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  var ALCANCES = [
    { id: 'seleccion', et: 'Lo que he marcado', ayuda: 'Los ficheros marcados ahora mismo.' },
    { id: 'carpeta',   et: 'Esta carpeta',      ayuda: 'La carpeta abierta, y las de dentro.' },
    { id: 'seccion',   et: 'Toda la sección',   ayuda: 'Todo lo de esta pantalla.' },
    { id: 'todo',      et: 'Todo',              ayuda: 'Tus cuatro secciones enteras.' }
  ];

  var PERMISOS = [
    { id: 'lectura',   et: 'Sólo ver' },
    { id: 'descarga',  et: 'Ver y descargar' },
    { id: 'escritura', et: 'Lectura y escritura' }
  ];

  var NOTA_PERMISO = {
    lectura: 'Enlace público, sin cuenta, y sin botón de descarga. Ojo: para '
      + 'enseñar el fichero hay que enviarlo, así que quien tenga el enlace '
      + 'puede guardarlo igualmente desde el navegador. Es un badén, no un candado.',
    descarga: 'Enlace público, sin cuenta. Quien lo tenga puede ver los '
      + 'ficheros y descargarlos, y puede reenviar el enlace.',
    escritura: 'Invitación de editor: quien la abra tendrá que iniciar sesión y '
      + 'podrá tocar tus archivos. No se puede acotar a una carpeta — un acceso '
      + 'de editor vale para tus cuatro secciones enteras—, así que sólo se '
      + 'ofrece con «Todo».'
  };

  var estado = { permiso: 'descarga', alcance: 'seleccion', ocupado: false };
  var caja = null;
  var escena3d = null;

  /* ── El contexto de la pantalla ───────────────────────────────────────────
     Cada pantalla publica en `window.ARBOLQR_CONTEXTO` de que seccion es y que
     carpeta tiene abierta, y lo refresca cada vez que carga una. Se hace asi y
     no leyendo las migas del DOM porque las migas son texto para mirar: la
     ruta de verdad la tiene la pantalla en una variable, y adivinarla desde el
     HTML seria reconstruir a mano algo que ya esta escrito. */
  function contexto() {
    var c = window.ARBOLQR_CONTEXTO;
    return {
      seccion: (c && c.seccion) || 'archivos',
      carpeta: (c && c.carpeta) || ''
    };
  }

  function marcados() {
    if (!window.SELECCION || !window.SELECCION.marcados) return [];
    return window.SELECCION.marcados();
  }

  /* La escritura no se puede acotar, asi que con ella solo vale «Todo». */
  function combinacionValida(permiso, alcance) {
    return permiso !== 'escritura' || alcance === 'todo';
  }

  /* ── El ajuste, guardado ──────────────────────────────────────────────────
     Igual que en l-notes: un ajuste que se olvida al recargar no es un ajuste.
     La clave lleva el nombre de la app porque el navegador es el mismo y
     l-notes guarda el suyo con otros valores; mezclarlos daria un alcance
     «nota» aqui, que no existe. */
  var CLAVE = 'l-archivos.qr.compartir';

  function esId(lista, v) {
    for (var i = 0; i < lista.length; i++) if (lista[i].id === v) return true;
    return false;
  }

  function cargarAjustes() {
    var g;
    try { g = JSON.parse(localStorage.getItem(CLAVE) || '{}'); } catch (e) { return; }
    if (esId(PERMISOS, g.permiso)) estado.permiso = g.permiso;
    if (esId(ALCANCES, g.alcance)) estado.alcance = g.alcance;
    // Lo guardado puede ser de una version anterior o una combinacion que ya
    // no vale; se corrige antes de que la vea nadie.
    if (!combinacionValida(estado.permiso, estado.alcance)) estado.alcance = 'todo';
  }

  function guardarAjustes() {
    try {
      localStorage.setItem(CLAVE, JSON.stringify({
        permiso: estado.permiso, alcance: estado.alcance
      }));
    } catch (e) { /* modo privado o cuota llena: no es motivo para romper nada */ }
  }

  /* ── El servidor ──────────────────────────────────────────────────────── */

  function pedirEnlace() {
    var c = contexto();
    var cuerpo = {
      alcance: estado.alcance,
      permiso: estado.permiso,
      seccion: c.seccion,
      carpeta: c.carpeta
    };
    if (estado.alcance === 'seleccion') {
      cuerpo.seleccion = marcados();
      if (!cuerpo.seleccion.length) {
        // Se corta aqui en vez de dejar que el servidor lo diga: el mensaje
        // puede ser mas concreto sabiendo que la pantalla tiene un boton de
        // «Seleccionar» y que a lo mejor ni esta encendido.
        return Promise.reject(new Error(
          'No has marcado nada. Enciende «Seleccionar» y marca lo que quieras '
          + 'compartir, o elige otro alcance aquí.'));
      }
    }
    return fetch('/api/qr/crear', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) throw new Error(j.error || ('Error ' + r.status));
        return j;
      });
    });
  }

  /* Que se acaba de repartir, para el rotulo del boton: el jardin no ensena el
     enlace en texto, solo se escanea. */
  function etiquetaReparto(j) {
    var a, p, i;
    for (i = 0; i < ALCANCES.length; i++) if (ALCANCES[i].id === j.alcance) a = ALCANCES[i].et;
    for (i = 0; i < PERMISOS.length; i++) if (PERMISOS[i].id === j.permiso) p = PERMISOS[i].et;
    return (a || j.alcance) + ' · ' + (p || j.permiso)
      + (j.cuantos ? ' · ' + j.cuantos + ' ficheros' : '');
  }

  /* ── El jardin de la esquina ──────────────────────────────────────────── */

  var SESION = String(Math.random()).slice(2);

  function semillaJardin() {
    var c = contexto();
    return SESION + '|' + c.seccion + '|' + c.carpeta;
  }

  function textoJardin() {
    return 'l-archivos · jardín · ' + semillaJardin();
  }

  function svgArbolito() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" '
      + 'aria-hidden="true">'
      + '<path d="M12 21v-5"/>'
      + '<path d="M12 16c-3.3 0-6-2.5-6-5.6C6 6.9 8.7 4 12 4s6 2.9 6 6.4c0 3.1-2.7 5.6-6 5.6z"/>'
      + '<path d="M9.5 10.5 12 12l2.5-1.5"/></svg>';
  }

  /* Como en l-notes: no se planta hasta que el contexto lleva un rato quieto.
     Al entrar, la pantalla todavia no ha cargado su primera carpeta, asi que
     `ARBOLQR_CONTEXTO` cambia solo un par de veces; plantar en el primer
     instante obligaba a replantar, y cada replante reinicia el crecimiento. */
  var ESPERA = 300, ESTABLES = 3, TOPE = 12;

  function alAsentarse(hacer) {
    var previa = semillaJardin(), quieta = 0, vueltas = 0;
    var reloj = setInterval(function () {
      var ahora = semillaJardin();
      if (ahora !== previa) { previa = ahora; quieta = 0; } else { quieta++; }
      if (quieta >= ESTABLES || ++vueltas >= TOPE) {
        clearInterval(reloj);
        hacer();
      }
    }, ESPERA);
  }

  function montarEsquina(boton) {
    if (!window.Arbol3D || !window.qrcode) return false;

    var lienzo = document.createElement('canvas');
    lienzo.className = 'aq-lienzo3d';
    lienzo.setAttribute('aria-hidden', 'true');
    boton.appendChild(lienzo);

    var jardin = window.Arbol3D.sorteo(semillaJardin());
    var escena;
    try {
      escena = window.Arbol3D.crear(lienzo, textoJardin(), jardin, {});
      if (!escena) { lienzo.remove(); return false; }
    } catch (e) {
      // Sin WebGL, o con un driver que se atraganta: el boton se queda con su
      // icono plano y el atajo puesto, y todo lo demas sigue igual.
      lienzo.remove();
      return false;
    }

    boton.classList.add('con3d');
    var pidiendo = false;
    var fase = 0;        // 0 rincon · 1 centrado con el jardin · 2 ensenando el QR
    var reparto = '';

    /* FLIP: se pone ya la posicion final, se mide, y se aplica al vuelo la
       transformacion inversa para devolverlo al sitio de partida. Al soltarla
       el navegador anima solo el `transform` —que va en la GPU— y al terminar
       el canvas ya esta a su tamano real, asi que se redibuja nitido en vez de
       escalado. Animar `width` sale a tirones y deja el canvas borroso. */
    function mover(alCentro) {
      var antes = boton.getBoundingClientRect();
      boton.classList.toggle('centrado', alCentro);
      var luego = boton.getBoundingClientRect();
      boton.style.transition = 'none';
      boton.style.transformOrigin = 'top left';
      boton.style.transform = 'translate(' +
        (antes.left - luego.left) + 'px,' + (antes.top - luego.top) + 'px) scale(' +
        (antes.width / luego.width) + ',' + (antes.height / luego.height) + ')';
      void boton.offsetWidth;                       // fuerza el reflow
      boton.style.transition = 'transform .55s cubic-bezier(.22,.9,.28,1)';
      boton.style.transform = '';
    }

    var velo = document.createElement('div');
    velo.className = 'aq-velo-jardin';
    document.body.appendChild(velo);

    function rotular() {
      boton.title = fase === 0 ? 'Abrir el jardín'
                  : fase === 1 ? 'Generar el QR para compartir'
                  : 'Volver al rincón' + (reparto ? ' · ' + reparto : '');
      boton.setAttribute('aria-label', boton.title);
    }
    rotular();

    function alRincon() {
      fase = 0;
      /* El enlace deja de estar a la vista, y va colgado del vuelo por lo
         mismo que a la ida: en el pico la copa ya tapa el suelo, asi que ese
         es el ultimo fotograma en que el codigo se ve. */
      escena.cenital(false, { texto: textoJardin(), sorteo: jardin, recrecer: true });
      mover(false);
      velo.classList.remove('visible');
      reparto = '';
      rotular();
    }

    /* Otra carpeta, otro jardin. Por sondeo y no con un MutationObserver: esto
       solo necesita enterarse de una cosa, y es un objeto que la pantalla
       reescribe entera cada vez que carga. */
    var ultima = semillaJardin();
    var asentado = false;
    var quieta = 0;
    setInterval(function () {
      if (document.hidden || fase !== 0) return;   // no en mitad del QR
      var ahora = semillaJardin();
      if (ahora !== ultima) {
        ultima = ahora;
        quieta = 0;
        jardin = window.Arbol3D.sorteo(ahora);
        // El tercer argumento es «callada»: cambia el jardin por debajo sin
        // reiniciar el crecimiento. Mientras el contexto se asienta hace falta.
        escena.regenerar(textoJardin(), jardin, !asentado);
        return;
      }
      if (!asentado && ++quieta >= 2) asentado = true;
    }, 600);

    velo.addEventListener('click', function () { if (fase) alRincon(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && fase) alRincon();
    });

    boton.addEventListener('click', function () {
      if (pidiendo) return;

      if (fase === 0) {                    // rincon → centro, todavia jardin
        fase = 1;
        mover(true);
        velo.classList.add('visible');
        rotular();
        return;
      }
      if (fase === 2) return alRincon();   // ya enseno el codigo

      pidiendo = true;
      boton.classList.add('pidiendo');
      pedirEnlace()
        .then(function (j) {
          /* Mismo jardin, ahora con el codigo bueno en el suelo, y el cambio
             colgado del vuelo: se monta en su pico, con la copa tapando el
             suelo. Ver `cenital` en arbol3d.js. */
          escena.cenital(true, { texto: j.url, sorteo: jardin });
          fase = 2;
          reparto = etiquetaReparto(j);
          rotular();
        })
        .catch(function (e) {
          // No se puede compartir con lo que hay configurado: se ensena el
          // dialogo con los ajustes, que es donde se arregla.
          abrir(true);
          fallo(e.message);
          if (fase === 1) alRincon();
        })
        .finally(function () {
          pidiendo = false;
          boton.classList.remove('pidiendo');
        });
    });

    document.addEventListener('visibilitychange', function () {
      escena.pausar(document.hidden);
    });

    return true;
  }

  /* ── El dialogo ───────────────────────────────────────────────────────── */

  function construirDialogo() {
    var d = document.createElement('div');
    d.className = 'aq-velo';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Compartir con un código QR');

    d.innerHTML =
      '<div class="aq-panel">'
      + '<button class="aq-cerrar" aria-label="Cerrar">&times;</button>'
      + '<h2 class="aq-titulo" id="aq-titulo">Compartir con un árbol</h2>'
      + '<div class="aq-grupo">'
      +   '<div class="aq-et">Permiso</div>'
      +   '<div class="aq-ops aq-ops-col" id="aq-permisos"></div>'
      +   '<p class="aq-nota" id="aq-nota-permiso"></p>'
      + '</div>'
      + '<div class="aq-grupo">'
      +   '<div class="aq-et">Qué se comparte</div>'
      +   '<div class="aq-ops aq-ops-col" id="aq-alcances"></div>'
      + '</div>'
      + '<div class="aq-acciones">'
      +   '<button type="button" class="aq-generar" id="aq-generar">Generar el árbol</button>'
      + '</div>'
      + '<p class="aq-cargando" id="aq-cargando" hidden>Plantando el árbol…</p>'
      + '<div class="aq-salida" id="aq-salida" hidden>'
      +   '<div class="aq-escena" id="aq-escena">'
      +     '<canvas id="aq-3d"></canvas>'
      +     '<div class="aq-plano" id="aq-plano" hidden></div>'
      +   '</div>'
      +   '<div class="aq-vistas">'
      +     '<button type="button" class="aq-vista activa" data-vista="3d">Árbol</button>'
      +     '<button type="button" class="aq-vista" data-vista="cenital">Cenital</button>'
      +     '<button type="button" class="aq-vista" data-vista="plano">Plano</button>'
      +   '</div>'
      +   '<p class="aq-aviso" id="aq-aviso"></p>'
      +   '<div class="aq-estacion" id="aq-estacion"></div>'
      +   '<div class="aq-url"><input type="text" id="aq-enlace" readonly>'
      +     '<button type="button" id="aq-copiar">Copiar</button></div>'
      +   '<button type="button" class="aq-descargar" id="aq-descargar">Descargar SVG</button>'
      +   '<p class="aq-pista" id="aq-pista">¿Otro alcance u otro permiso? '
      +     'Están en el menú de la barra, en <b>Compartir con un árbol</b>.</p>'
      + '</div>'
      + '<p class="aq-error" id="aq-error" hidden></p>'
      + '</div>';

    function pintarOpciones(caja_, lista) {
      lista.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'aq-op';
        b.dataset.v = a.id;
        b.innerHTML = a.ayuda
          ? '<span>' + a.et + '</span><small>' + a.ayuda + '</small>'
          : '<span>' + a.et + '</span>';
        caja_.appendChild(b);
      });
    }
    pintarOpciones(d.querySelector('#aq-permisos'), PERMISOS);
    pintarOpciones(d.querySelector('#aq-alcances'), ALCANCES);

    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.closest('.aq-cerrar')) cerrar();
    });
    d.querySelector('#aq-permisos').addEventListener('click', function (e) {
      var b = e.target.closest('.aq-op'); if (!b) return;
      estado.permiso = b.dataset.v; pintarSeleccion(); guardarAjustes();
    });
    d.querySelector('#aq-alcances').addEventListener('click', function (e) {
      var b = e.target.closest('.aq-op'); if (!b || b.disabled) return;
      estado.alcance = b.dataset.v; pintarSeleccion(); guardarAjustes();
    });
    d.querySelector('#aq-generar').addEventListener('click', generar);
    d.querySelector('#aq-copiar').addEventListener('click', copiar);
    d.querySelector('#aq-descargar').addEventListener('click', descargar);
    d.querySelector('.aq-vistas').addEventListener('click', function (e) {
      var b = e.target.closest('.aq-vista');
      if (b) cambiarVista(b.dataset.vista);
    });
    d.querySelector('#aq-3d').addEventListener('click', function () {
      if (!escena3d) return;
      cambiarVista(escena3d.esCenital() ? '3d' : 'cenital');
    });

    return d;
  }

  /* Tres vistas, y la diferencia no es estetica:
       arbol   — en escorzo. Bonito, y un QR en escorzo NO se escanea.
       cenital — la camara justo encima: la matriz se ve recta y ya se lee.
       plano   — el SVG de siempre, que escanea sin discusion y es el que se
                 descarga. */
  function cambiarVista(cual) {
    if (!caja) return;
    caja.querySelectorAll('.aq-vista').forEach(function (b) {
      b.classList.toggle('activa', b.dataset.vista === cual);
    });
    var plano = caja.querySelector('#aq-plano');
    var lienzo3d = caja.querySelector('#aq-3d');
    var esPlano = cual === 'plano';
    plano.hidden = !esPlano;
    lienzo3d.hidden = esPlano;
    if (escena3d && !esPlano) escena3d.cenital(cual === 'cenital');
    caja.querySelector('#aq-aviso').textContent = cual === '3d'
      ? 'Toca el árbol para ver el QR desde arriba.'
      : 'Esta vista sí se escanea.';
  }

  function pintarSeleccion() {
    if (!caja) return;
    caja.querySelectorAll('#aq-permisos .aq-op').forEach(function (b) {
      b.classList.toggle('activa', b.dataset.v === estado.permiso);
    });
    caja.querySelectorAll('#aq-alcances .aq-op').forEach(function (b) {
      var ok = combinacionValida(estado.permiso, b.dataset.v);
      b.disabled = !ok;
      b.classList.toggle('vetada', !ok);
      b.classList.toggle('activa', ok && b.dataset.v === estado.alcance);
    });
    // Si la combinacion deja de valer, se cae a la unica que vale con
    // escritura — y se guarda, o al recargar volveria la imposible.
    if (!combinacionValida(estado.permiso, estado.alcance)) {
      estado.alcance = 'todo';
      guardarAjustes();
      return pintarSeleccion();
    }
    caja.querySelector('#aq-nota-permiso').textContent = NOTA_PERMISO[estado.permiso] || '';
  }

  function fallo(msg) {
    if (!caja) return;
    var p = caja.querySelector('#aq-error');
    p.textContent = msg;
    p.hidden = !msg;
  }

  function generar() {
    if (estado.ocupado) return;
    fallo('');
    estado.ocupado = true;
    var boton = caja.querySelector('#aq-generar');
    boton.disabled = true;
    boton.textContent = 'Generando…';
    caja.querySelector('#aq-cargando').hidden = false;

    pedirEnlace()
      .then(function (j) { pintarArbol(j); })
      .catch(function (e) { fallo(e.message); })
      .finally(function () {
        estado.ocupado = false;
        boton.disabled = false;
        boton.textContent = 'Generar el árbol';
        caja.querySelector('#aq-cargando').hidden = true;
      });
  }

  function pintarArbol(j) {
    var url = j.url;
    var pal = window.ArbolQR.paletaAlAzar();

    var plano = caja.querySelector('#aq-plano');
    plano.textContent = '';
    plano.appendChild(window.ArbolQR.construir(url, pal));

    caja.querySelector('#aq-salida').hidden = false;   // hay que verlo para medirlo

    if (escena3d) { escena3d.destruir(); escena3d = null; }
    var lienzo3d = caja.querySelector('#aq-3d');
    var hay3d = false;
    try {
      // Sembrado con la propia URL: el mismo enlace da siempre el mismo arbol.
      escena3d = window.Arbol3D
        && window.Arbol3D.crear(lienzo3d, url, window.Arbol3D.sorteo(url),
                                { fondo: [0.965, 0.945, 0.906] });
      hay3d = !!escena3d;
    } catch (e) { escena3d = null; }

    caja.querySelector('.aq-vistas').hidden = !hay3d;
    cambiarVista(hay3d ? '3d' : 'plano');
    if (!hay3d) {
      caja.querySelector('#aq-aviso').textContent =
        'Este navegador no trae WebGL, así que el árbol va en plano.';
    }

    caja.querySelector('#aq-estacion').textContent =
      (hay3d ? escena3d.sorteo.nombre + ' · ' : '') + etiquetaReparto(j);
    caja.querySelector('#aq-enlace').value = url;
  }

  function copiar() {
    var campo = caja.querySelector('#aq-enlace');
    campo.select();
    var hecho = function () {
      var b = caja.querySelector('#aq-copiar');
      b.textContent = 'Copiado';
      setTimeout(function () { b.textContent = 'Copiar'; }, 1600);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(campo.value).then(hecho, function () {});
    } else {
      try { document.execCommand('copy'); hecho(); } catch (e) {}
    }
  }

  function descargar() {
    // Siempre el plano: es el que escanea, y un PNG del canvas en escorzo
    // seria un adorno que no sirve para lo que se descarga.
    var svg = caja.querySelector('#aq-plano svg');
    if (!svg) return;
    var texto = new XMLSerializer().serializeToString(svg);
    var url = URL.createObjectURL(new Blob([texto], { type: 'image/svg+xml' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'arbol-qr.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function abrir(conAjustes) {
    if (!caja) {
      caja = construirDialogo();
      document.body.appendChild(caja);
    }
    caja.classList.toggle('solo-resultado', !conAjustes);
    caja.querySelector('#aq-titulo').textContent = conAjustes
      ? 'Compartir con un árbol' : 'Tu árbol';
    caja.querySelector('#aq-salida').hidden = true;
    caja.querySelector('#aq-cargando').hidden = true;
    fallo('');
    pintarSeleccion();
    caja.classList.add('abierto');
    document.addEventListener('keydown', alEscape);
  }

  /* El atajo del boton sin WebGL: se comparte con lo que haya en el ajuste. */
  function abrirRapido() {
    abrir(false);
    generar();
  }

  function cerrar() {
    if (!caja) return;
    caja.classList.remove('abierto');
    document.removeEventListener('keydown', alEscape);
    // Un canvas con su bucle rAF detras de un dialogo cerrado es bateria
    // tirada. Se vuelve a montar al generar el siguiente.
    if (escena3d) { escena3d.destruir(); escena3d = null; }
  }

  function alEscape(e) { if (e.key === 'Escape') cerrar(); }

  function iniciar() {
    // Solo donde hay algo que compartir: la portada y torrents no lo llevan.
    if (!window.ARBOLQR_CONTEXTO) return;

    cargarAjustes();

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'aq-boton';
    b.title = 'Compartir con un código QR';
    b.setAttribute('aria-label', 'Compartir con un código QR');
    b.innerHTML = svgArbolito();
    document.body.appendChild(b);

    // Mientras se espera a que el contexto se asiente, el atajo va puesto: el
    // boton esta en pantalla desde el primer momento y no puede quedarse un
    // segundo sin hacer nada al pulsarlo.
    b.addEventListener('click', abrirRapido);
    alAsentarse(function () {
      b.removeEventListener('click', abrirRapido);
      if (!montarEsquina(b)) b.addEventListener('click', abrirRapido);
    });

    // Y la entrada del menu de la barra, que es el «botón de ajustes»: el
    // mismo dialogo, pero con los selectores a la vista.
    var enMenu = document.getElementById('menu-compartir-arbol');
    if (enMenu) {
      // Nace oculta en ajustes.js, que es el mismo menu para las cuatro
      // pantallas: en la portada no hay nada que compartir y una entrada que
      // no hace nada es peor que no tenerla. Se destapa aqui, que es donde se
      // sabe que si hay.
      enMenu.hidden = false;
      enMenu.addEventListener('click', function (e) {
        e.preventDefault();
        var menu = document.getElementById('menu-usuario');
        if (menu) menu.hidden = true;
        var boton = document.getElementById('boton-menu');
        if (boton) boton.setAttribute('aria-expanded', 'false');
        abrir(true);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
