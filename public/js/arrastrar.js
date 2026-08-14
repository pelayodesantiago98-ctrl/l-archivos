'use strict';
/*
 * Arrastrar y soltar en las listas de ficheros.
 *
 * Dos gestos con el mismo movimiento:
 *   - soltar encima de una carpeta la mete dentro
 *   - soltar entre dos cosas la coloca ahi, y ese orden se guarda
 *
 * Va aparte y no dentro de cada pantalla porque documentos y archivos pintan
 * distinto —tarjetas unos, filas otros— pero se arrastran igual. Cada pantalla
 * dice donde estan sus elementos y como recargarse; lo demas es de aqui.
 *
 * Esto usaba la API de arrastre que trae el navegador y hubo que cambiarla,
 * porque no llegaba a arrancar nunca:
 *
 *   - En documentos la tarjeta entera es un <button>, y un control de
 *     formulario se queda con el gesto del raton en vez de dejar que empiece
 *     el arrastre de su contenedor.
 *   - Y en tactil no existe: esa API solo entiende de raton, asi que en una
 *     tablet no habria funcionado de ninguna manera.
 *
 * Con eventos de puntero da igual si es un dedo o un raton, no hay controles
 * que se lleven el gesto, y el dibujo que sigue al puntero lo hace este
 * fichero en vez del navegador: por eso el original se puede esconder de
 * verdad y ya no se ven dos copias de la misma cosa.
 */
(function () {
  var UMBRAL = 8;          // px que hay que moverse con el raton para que cuente
  var ESPERA_DEDO = 320;   // ms de pulsacion larga para arrancar en tactil
  var MARGEN = 90;         // franja del borde donde la lista se desplaja sola

  var vivo = null;         // lo que se esta arrastrando ahora mismo
  var marca = null;        // la raya que enseña donde va a caer
  var migas = [];          // zonas de migas de pan registradas

  function api(ruta, cuerpo) {
    return fetch(ruta, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw new Error(d.error || ('Error ' + res.status));
        return d;
      });
    });
  }

  function quitarMarca() {
    if (marca && marca.parentNode) marca.parentNode.removeChild(marca);
    marca = null;
  }

  function quitarResaltados() {
    var todos = document.querySelectorAll('.destino');
    for (var i = 0; i < todos.length; i++) todos[i].classList.remove('destino');
  }

  /* Donde caeria si se soltara ahora: antes o despues de lo que hay debajo del
     puntero, segun por que mitad se pase. */
  function ponerMarca(sobre, x, y, horizontal) {
    var caja = sobre.getBoundingClientRect();
    var mitad = horizontal ? caja.left + caja.width / 2 : caja.top + caja.height / 2;
    var antes = horizontal ? x < mitad : y < mitad;

    if (!marca) {
      marca = document.createElement('div');
      marca.className = 'marca-suelta' + (horizontal ? '' : ' horizontal');
    }
    sobre.parentNode.insertBefore(marca, antes ? sobre : sobre.nextSibling);
  }

  /* Que hay bajo el puntero. El clon lleva pointer-events:none y el original
     esta escondido, asi que ninguno de los dos estorba. */
  function debajo(x, y) {
    var n = document.elementFromPoint(x, y);
    return n || null;
  }

  /* Recibe cual hay que ignorar en vez de mirarlo de «vivo»: al soltar ya se
     ha vaciado, y ahi es justo donde hace falta. */
  function elementoBajo(x, y, cfg, excepto) {
    var n = debajo(x, y);
    var e = n && n.closest ? n.closest(cfg.elemento) : null;
    return e && e !== excepto ? e : null;
  }

  function migaBajo(x, y) {
    var n = debajo(x, y);
    if (!n || !n.closest) return null;
    for (var i = 0; i < migas.length; i++) {
      if (migas[i].zona.contains(n)) {
        var a = n.closest('[data-rel]');
        if (a && migas[i].zona.contains(a)) return { a: a, cfg: migas[i].cfg };
      }
    }
    return null;
  }

  /* Si el puntero se acerca al borde, la pagina acompaña. El arrastre del
     navegador lo hacia solo; aqui hay que ponerlo. */
  function acompanar(y) {
    var alto = window.innerHeight;
    if (y < MARGEN) window.scrollBy(0, -Math.ceil((MARGEN - y) / 6));
    else if (y > alto - MARGEN) window.scrollBy(0, Math.ceil((y - (alto - MARGEN)) / 6));
  }

  function crearClon(el, x, y) {
    var caja = el.getBoundingClientRect();
    var clon = el.cloneNode(true);
    clon.classList.add('fantasma-arrastre');
    clon.classList.remove('arrastrando');
    clon.removeAttribute('id');
    clon.style.width = caja.width + 'px';
    clon.style.height = caja.height + 'px';
    clon.style.left = caja.left + 'px';
    clon.style.top = caja.top + 'px';
    document.body.appendChild(clon);
    return { clon: clon, dx: x - caja.left, dy: y - caja.top };
  }

  function arrancar(x, y) {
    var v = vivo;
    if (!v || v.arrancado) return;
    v.arrancado = true;
    clearTimeout(v.reloj);

    var c = crearClon(v.el, x, y);
    v.clon = c.clon;
    v.dx = c.dx;
    v.dy = c.dy;
    v.el.classList.add('arrastrando');
    document.body.classList.add('arrastrando-algo');
    seguir(x, y);
  }

  function seguir(x, y) {
    var v = vivo;
    if (!v || !v.arrancado) return;

    v.clon.style.left = (x - v.dx) + 'px';
    v.clon.style.top = (y - v.dy) + 'px';
    acompanar(y);

    quitarResaltados();

    var miga = migaBajo(x, y);
    if (miga) { quitarMarca(); miga.a.classList.add('destino'); return; }

    var sobre = elementoBajo(x, y, v.cfg, v.el);
    if (!sobre) { quitarMarca(); return; }

    /* La pantalla puede vetar sitios: la galeria, por ejemplo, no deja mover
       una foto a otro dia. Sin marca ni resaltado no hay donde soltar, asi que
       el gesto se queda en nada y cada cosa vuelve a su sitio. */
    if (v.cfg.puedeSoltar && !v.cfg.puedeSoltar(v.el, sobre)) {
      quitarMarca();
      return;
    }

    if (sobre.dataset.carpeta === '1') {
      quitarMarca();
      sobre.classList.add('destino');
    } else {
      ponerMarca(sobre, x, y, v.cfg.horizontal !== false);
    }
  }

  function recoger(v) {
    if (v.clon && v.clon.parentNode) v.clon.parentNode.removeChild(v.clon);
    if (v.el) v.el.classList.remove('arrastrando');
    document.body.classList.remove('arrastrando-algo');
    quitarResaltados();
    quitarMarca();
  }

  /* Tras arrastrar, el navegador manda un click en cuanto se levanta el dedo.
     Sin esto, soltar un documento encima de otro lo abriria. */
  function comerseElClick() {
    function quitar() { document.removeEventListener('click', tapon, true); }
    function tapon(e) { e.preventDefault(); e.stopPropagation(); quitar(); }
    document.addEventListener('click', tapon, true);
    /* Y si ese click no llega a producirse, el tapon se desarma solo: si se
       quedara puesto se comeria el siguiente clic de verdad. */
    setTimeout(quitar, 0);
  }

  async function soltar(x, y) {
    var v = vivo;
    vivo = null;
    if (!v) return;
    desatar();
    clearTimeout(v.reloj);
    if (!v.arrancado) return;   // fue un clic de los de toda la vida

    comerseElClick();

    var cfg = v.cfg;
    var miga = migaBajo(x, y);
    var sobre = elementoBajo(x, y, cfg, v.el);
    var enCarpeta = sobre && sobre.dataset.carpeta === '1'
      && sobre.classList.contains('destino');

    try {
      if (miga) {
        recoger(v);
        await api('/api/f/' + miga.cfg.tipo + '/mover',
          { f: v.el.dataset.rel, a: miga.a.dataset.rel });
        miga.cfg.recargar('Movido.');
        return;
      }

      if (enCarpeta) {
        var nombreCarpeta = sobre.dataset.nombre;
        var aDonde = sobre.dataset.rel;
        recoger(v);
        await api('/api/f/' + cfg.tipo + '/mover', { f: v.el.dataset.rel, a: aDonde });
        cfg.recargar('Movido a «' + nombreCarpeta + '».');
        return;
      }

      /* Soltar en el hueco, sin marca y sin carpeta debajo, es arrepentirse:
         se deja todo como estaba en vez de reescribir el orden con lo mismo. */
      if (!marca || !marca.parentNode) { recoger(v); return; }

      /* Reordenar: la marca ya enseña donde va a caer, asi que basta con poner
         el elemento en su sitio y leer el orden que queda. */
      marca.parentNode.insertBefore(v.el, marca);
      recoger(v);

      var contenedor = document.getElementById(cfg.contenedor);
      var nombres = [];
      var actuales = contenedor.querySelectorAll(cfg.elemento);
      for (var k = 0; k < actuales.length; k++) {
        if (actuales[k].dataset.nombre) nombres.push(actuales[k].dataset.nombre);
      }
      /* Si la pantalla tiene cosas fuera de la vista —filtradas—, es ella quien
         sabe donde encajan: lo que se ve no es toda la lista. */
      if (cfg.ordenCompleto) nombres = cfg.ordenCompleto(nombres);

      await api('/api/f/' + cfg.tipo + '/orden', { en: cfg.carpeta || '', nombres: nombres });
      if (cfg.alOrdenar) cfg.alOrdenar();
    } catch (err) {
      recoger(v);
      cfg.recargar(null, err.message);
    }
  }

  function cancelar() {
    var v = vivo;
    vivo = null;
    if (!v) return;
    desatar();
    clearTimeout(v.reloj);
    if (v.arrancado) { recoger(v); v.cfg.recargar(); }
  }

  // ── Escuchas mientras dura el gesto ───────────────────────────────────────

  function alMover(e) {
    var v = vivo;
    if (!v) return;

    if (!v.arrancado) {
      var lejos = Math.abs(e.clientX - v.x0) + Math.abs(e.clientY - v.y0);
      /* Con el dedo, moverse antes de tiempo es desplazar la lista, no
         arrastrar: se deja pasar y se olvida el gesto. Con el raton, moverse
         es justo lo que lo arranca. */
      if (v.dedo) { if (lejos > UMBRAL) cancelar(); return; }
      if (lejos < UMBRAL) return;
      arrancar(e.clientX, e.clientY);
    }
    seguir(e.clientX, e.clientY);
  }

  /* Una vez arrancado hay que impedir que el dedo desplace la pagina, y eso
     solo se puede hacer si la escucha no es pasiva. */
  function alTocar(e) {
    if (vivo && vivo.arrancado && e.cancelable) e.preventDefault();
  }

  function alSoltar(e) { soltar(e.clientX, e.clientY); }
  function alTecla(e) { if (e.key === 'Escape') cancelar(); }

  function atar() {
    document.addEventListener('pointermove', alMover);
    document.addEventListener('pointerup', alSoltar);
    document.addEventListener('pointercancel', cancelar);
    document.addEventListener('touchmove', alTocar, { passive: false });
    document.addEventListener('keydown', alTecla);
  }

  function desatar() {
    document.removeEventListener('pointermove', alMover);
    document.removeEventListener('pointerup', alSoltar);
    document.removeEventListener('pointercancel', cancelar);
    document.removeEventListener('touchmove', alTocar);
    document.removeEventListener('keydown', alTecla);
  }

  // ── Montaje ──────────────────────────────────────────────────────────────

  function montar(cfg) {
    var contenedor = document.getElementById(cfg.contenedor);
    if (!contenedor) return;

    var elementos = contenedor.querySelectorAll(cfg.elemento);
    for (var i = 0; i < elementos.length; i++) {
      (function (el) {
        if (!el.dataset.rel) return;
        el.classList.add('arrastrable');

        /* El arrastre del navegador se apaga a proposito: si sigue encendido
           se dispara a la vez que este y se ven las dos cosas moviendose. */
        el.draggable = false;
        var dentro = el.querySelectorAll('*');
        for (var j = 0; j < dentro.length; j++) dentro[j].draggable = false;

        el.addEventListener('pointerdown', function (e) {
          if (e.button !== undefined && e.button !== 0) return;  // solo el boton principal
          if (vivo) return;

          vivo = {
            cfg: cfg, el: el, arrancado: false,
            x0: e.clientX, y0: e.clientY,
            dedo: e.pointerType !== 'mouse',
            reloj: null,
          };
          atar();

          /* Con el dedo no hay forma de distinguir «voy a arrastrar» de «voy a
             desplazar la lista» mas que por el tiempo: se mantiene pulsado. */
          if (vivo.dedo) {
            var x = e.clientX, y = e.clientY;
            vivo.reloj = setTimeout(function () { arrancar(x, y); }, ESPERA_DEDO);
          }
        });
      })(elementos[i]);
    }
  }

  /* Soltar sobre una miga de pan sube el fichero a esa carpeta, que es como se
     sale de una carpeta sin tener que abrir dos ventanas. */
  function montarMigas(cfg) {
    var zona = document.getElementById(cfg.migas);
    if (!zona) return;
    for (var i = 0; i < migas.length; i++) {
      if (migas[i].zona === zona) { migas[i].cfg = cfg; return; }
    }
    migas.push({ zona: zona, cfg: cfg });
  }

  window.ARRASTRAR = { montar: montar, montarMigas: montarMigas };
})();
