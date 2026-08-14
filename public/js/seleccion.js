'use strict';
/*
 * Coger varias cosas a la vez y hacer algo con todas.
 *
 * Se enciende con el boton «Seleccionar» y mientras dura, pulsar una ficha la
 * marca en vez de abrirla. Abajo aparece una barra con lo que se puede hacer:
 * duplicar, compartir y eliminar.
 *
 * Va aparte porque documentos y archivos pintan la misma rejilla y se manejan
 * igual. Cada pantalla dice de que seccion es y como recargarse.
 *
 * El clic se atrapa en la fase de captura, sobre el contenedor: la ficha lleva
 * dentro un boton que abre el fichero, y esperar a que el evento llegue hasta
 * el seria llegar tarde.
 */
(function () {
  var cfg = null;
  var encendida = false;
  var marcados = [];      // rel de cada cosa marcada, en el orden en que se marco
  var barra = null;
  var enganchado = null;  // contenedor que ya tiene el escuchador puesto

  /* Sin montar no hay nada que mirar. Pasa si una pantalla enciende el modo
     antes de pintar la primera lista, y sin esto reventaba con un error que se
     llevaba por delante el resto del manejador. */
  function elementos() {
    if (!cfg) return [];
    var caja = document.getElementById(cfg.contenedor);
    return caja ? caja.querySelectorAll(cfg.elemento) : [];
  }

  function datosDe(el) {
    return {
      rel: el.dataset.rel,
      nombre: el.dataset.nombre,
      carpeta: el.dataset.carpeta === '1',
    };
  }

  function estaMarcado(rel) { return marcados.indexOf(rel) !== -1; }

  function alternar(el) {
    var rel = el.dataset.rel;
    if (!rel) return;
    var i = marcados.indexOf(rel);
    if (i === -1) marcados.push(rel);
    else marcados.splice(i, 1);
    pintar();
  }

  /* Repinta las marcas sobre lo que hay ahora en pantalla. Se llama tambien al
     recargar la lista: los elementos son nuevos cada vez, pero lo marcado sigue
     siendo lo mismo mientras no cambie de carpeta. */
  function pintar() {
    var lista = elementos();
    var vivos = [];
    for (var i = 0; i < lista.length; i++) {
      var el = lista[i];
      var si = estaMarcado(el.dataset.rel);
      el.classList.toggle('marcado', si);
      el.setAttribute('aria-pressed', si ? 'true' : 'false');
      if (si) vivos.push(el.dataset.rel);
    }
    /* Lo que ya no esta —borrado, movido, o simplemente otra carpeta— deja de
       contar: si no, la barra diria «3 seleccionados» sin que se vea ninguno. */
    marcados = marcados.filter(function (r) { return vivos.indexOf(r) !== -1; });
    pintarBarra();
  }

  // ── La barra de abajo ──────────────────────────────────────────────────

  function boton(texto, clase, alPulsar) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sel-boton' + (clase ? ' ' + clase : '');
    b.textContent = texto;
    b.onclick = alPulsar;
    return b;
  }

  function pintarBarra() {
    if (!encendida) {
      if (barra && barra.parentNode) barra.parentNode.removeChild(barra);
      barra = null;
      return;
    }
    if (!barra) {
      barra = document.createElement('div');
      barra.className = 'barra-seleccion';
      barra.setAttribute('role', 'toolbar');
      document.body.appendChild(barra);
    }
    barra.textContent = '';

    var cuantos = marcados.length;
    var cuenta = document.createElement('span');
    cuenta.className = 'sel-cuenta';
    cuenta.textContent = cuantos === 0 ? 'Nada seleccionado'
      : cuantos + (cuantos === 1 ? ' seleccionado' : ' seleccionados');
    barra.appendChild(cuenta);

    var acciones = document.createElement('div');
    acciones.className = 'sel-acciones';

    var duplicar = boton('Duplicar', '', hacerDuplicar);
    duplicar.disabled = cuantos === 0;
    acciones.appendChild(duplicar);

    var compartir = boton('Compartir', '', hacerCompartir);
    compartir.disabled = cuantos === 0;
    if (cuantos > 1) compartir.title = 'Un solo enlace con las ' + cuantos + ' cosas.';
    acciones.appendChild(compartir);

    var eliminar = boton('Eliminar', 'peligro', hacerEliminar);
    eliminar.disabled = cuantos === 0;
    acciones.appendChild(eliminar);

    acciones.appendChild(boton('Hecho', 'sel-hecho', apagar));
    barra.appendChild(acciones);
  }

  // ── Lo que se puede hacer ──────────────────────────────────────────────

  function api(ruta, opciones) {
    return fetch(ruta, Object.assign({ credentials: 'same-origin' }, opciones))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || ('Error ' + r.status));
          return d;
        });
      });
  }

  function cadaUno(quefaltan, hacer, alTerminar) {
    var bien = 0, malos = [];
    var siguiente = function (i) {
      if (i >= quefaltan.length) return alTerminar(bien, malos);
      hacer(quefaltan[i]).then(function () { bien++; }).catch(function (e) {
        malos.push(e.message);
      }).then(function () { siguiente(i + 1); });
    };
    siguiente(0);
  }

  function hacerDuplicar() {
    var quienes = marcados.slice();
    cadaUno(quienes, function (rel) {
      return api('/api/f/' + cfg.tipo + '/duplicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ f: rel }),
      });
    }, function (bien, malos) {
      marcados = [];
      cfg.recargar(bien + (bien === 1 ? ' copia hecha.' : ' copias hechas.'),
                   malos.length ? malos.join('; ') : null);
    });
  }

  /*
   * Con uno se abre el cuadro de siempre, que trae el QR, la caducidad y la
   * lista de enlaces repartidos. Con varios eso no encaja —no hay una foto que
   * ensenar— asi que se pide el enlace, se copia y se avisa: quien lo abra ve
   * la lista de las cosas y se baja las que quiera.
   */
  function hacerCompartir() {
    if (!marcados.length) return;

    if (marcados.length === 1) {
      var lista = elementos();
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].dataset.rel === marcados[0]) {
          if (window.Compartir) window.Compartir.abrir(cfg.tipo, datosDe(lista[i]));
          return;
        }
      }
      return;
    }

    var cuantos = marcados.length;
    api('/api/compartir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: cfg.tipo, f: marcados.slice(), dias: 7 }),
    }).then(function (r) {
      /* Se copia si se puede, pero el enlace se enseña de todas formas: sin
         portapapeles —o sin permiso— quedarse sin el enlace y sin aviso seria
         lo peor de los dos mundos. */
      var copiar = navigator.clipboard
        ? navigator.clipboard.writeText(r.url).then(function () { return true; },
                                                    function () { return false; })
        : Promise.resolve(false);
      copiar.then(function (copiado) {
        marcados = [];
        cfg.recargar((copiado ? 'Enlace copiado' : 'Enlace') + ' con ' + cuantos
          + ' cosas, para 7 días:\n' + r.url);
      });
    }).catch(function (e) { cfg.recargar(null, e.message); });
  }

  function hacerEliminar() {
    var quienes = marcados.slice();
    if (!quienes.length) return;
    var aviso = quienes.length === 1
      ? '¿Eliminar «' + quienes[0] + '»?'
      : '¿Eliminar ' + quienes.length + ' elementos?';
    if (!confirm(aviso)) return;

    cadaUno(quienes, function (rel) {
      return api('/api/f/' + cfg.tipo + '?f=' + encodeURIComponent(rel) + '&contodo=1',
                 { method: 'DELETE' });
    }, function (bien, malos) {
      marcados = [];
      cfg.recargar(bien + (bien === 1 ? ' eliminado.' : ' eliminados.'),
                   malos.length ? malos.join('; ') : null);
    });
  }

  // ── Encender y apagar ──────────────────────────────────────────────────

  function encender() {
    encendida = true;
    marcados = [];
    document.body.classList.add('seleccionando');
    pintar();
  }

  function apagar() {
    encendida = false;
    marcados = [];
    document.body.classList.remove('seleccionando');
    var lista = elementos();
    for (var i = 0; i < lista.length; i++) {
      lista[i].classList.remove('marcado');
      lista[i].removeAttribute('aria-pressed');
    }
    pintarBarra();
  }

  function montar(nuevo) {
    cfg = nuevo;

    var caja = document.getElementById(cfg.contenedor);
    if (caja && enganchado !== caja) {
      /* En captura: la ficha lleva dentro el boton que abre el fichero, y si
         se espera a que el evento llegue hasta aqui ya lo habra abierto. */
      caja.addEventListener('click', function (e) {
        if (!encendida) return;
        var el = e.target.closest(cfg.elemento);
        if (!el || !el.dataset.rel) return;
        e.preventDefault();
        e.stopPropagation();
        alternar(el);
      }, true);
      enganchado = caja;
    }

    if (encendida) pintar();
  }

  window.SELECCION = {
    montar: montar,
    encender: encender,
    apagar: apagar,
    activa: function () { return encendida; },
  };
})();
