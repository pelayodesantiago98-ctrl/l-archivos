'use strict';
/*
 * El menu de ajustes de la barra: la foto de perfil, el enlace al portal y el
 * tema.
 *
 * Vive aqui y no en cada pantalla porque son cuatro —portada, galeria,
 * documentos y archivos— y tenerlo escrito cuatro veces significa corregirlo
 * cuatro veces. El guion se trae su propio HTML: es marcado fijo, sin nada que
 * venga de fuera, asi que insertarlo de una pieza es seguro y ahorra repetir
 * cincuenta lineas de SVG en cada fichero.
 *
 * Se monta solo si la pantalla tiene barra y no lo trae ya puesto, para que la
 * portada —que lo lleva escrito— no acabe con dos.
 */
(function () {
  var barra = document.querySelector('.barra');
  if (!barra || document.getElementById('boton-menu')) return;

  barra.insertAdjacentHTML('beforeend', `<div class="menu-usuario">
    <button type="button" class="avatar-boton" id="boton-menu"
            aria-haspopup="menu" aria-expanded="false" aria-controls="menu-usuario"
            aria-label="Abrir el menú">
      <img src="https://lepayimio.es/perfil/foto" alt="" width="34" height="34"
           onerror="this.remove()">
    </button>
    <div class="menu" id="menu-usuario" role="menu" hidden>
      <a href="https://lepayimio.es/" role="menuitem"><svg class="menu-icono ico ico-inicio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-tejado" d="M5 12l-2 0l9 -9l9 9l-2 0"/><path class="ico-casa" d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path class="ico-puerta" d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/></svg>Inicio de lepayimio</a>
      <hr>
      <a href="/" role="menuitem"><svg class="menu-icono ico ico-subir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2 -2v-4"/><g class="ico-flecha-arriba"><path d="M12 3v12"/><path d="m17 8 -5 -5 -5 5"/></g></svg>Subir archivo</a>
      <a href="/fotos" role="menuitem"><svg class="menu-icono" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4V5zm2 2v7l3.5-3.5L13 14l3-3 2 2V7H6zm2.5 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3z"/></svg>Galería</a>
      <a href="/documentos" role="menuitem"><svg class="menu-icono" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l4 4v16H6V2zm7 1.5V7h3.5L13 3.5zM8 12h8v1.5H8V12zm0 3h8v1.5H8V15zm0-6h4v1.5H8V9z"/></svg>Documentos</a>
      <a href="/archivos" role="menuitem"><svg class="menu-icono ico ico-carpeta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-solapa" d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/></svg>Archivos</a>
      <hr>
      <form method="post" action="/salir" class="menu-forma">
        <button type="submit" role="menuitem"><svg class="menu-icono ico ico-salir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-puerta" d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2"/><path class="ico-flecha" d="M9 12h12"/><path class="ico-flecha" d="M18 15l3 -3l-3 -3"/></svg>Desconectarse</button>
      </form>
    </div>
  </div>`);
  document.body.insertAdjacentHTML('beforeend', `<div class="tema-velo" id="tema-velo" hidden>
  <div class="tema-ventana" role="dialog" aria-modal="true" aria-labelledby="tema-titulo">
    <div class="tema-barra">
      <b id="tema-titulo">Tema</b>
      <button type="button" class="tema-cerrar" data-cierra-tema aria-label="Cerrar">Hecho</button>
    </div>
      <!-- Sin hidden: quien decide si se ve es la ventana que lo rodea. -->
        <div class="submenu" id="submenu-temas" role="group" aria-label="Tema">
        <button type="button" class="menu-tema" role="menuitemradio" data-tema="claro">
          <span class="tema-muestra claro">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>
          </span>
          <span class="tema-nombre">Claro</span>
          <span class="tema-tic"><svg class="ico ico-tic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-marca" d="M5 12l5 5l10 -10"/></svg></span>
        </button>
        <button type="button" class="menu-tema" role="menuitemradio" data-tema="crystal">
          <span class="tema-muestra crystal">
            <svg class="ico ico-capas" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-capa-alta" d="M12 6l-8 4l8 4l8 -4l-8 -4"/><path class="ico-capa-baja" d="M4 14l8 4l8 -4"/></svg>
          </span>
          <span class="tema-nombre">Crystal</span>
          <span class="tema-tic"><svg class="ico ico-tic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-marca" d="M5 12l5 5l10 -10"/></svg></span>
        </button>
        <button type="button" class="menu-tema" role="menuitemradio" data-tema="dark-crystal">
          <span class="tema-muestra dark-crystal">
            <svg class="ico ico-capas" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-capa-alta" d="M12 6l-8 4l8 4l8 -4l-8 -4"/><path class="ico-capa-baja" d="M4 14l8 4l8 -4"/></svg>
          </span>
          <span class="tema-nombre">Dark Crystal</span>
          <span class="tema-tic"><svg class="ico ico-tic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-marca" d="M5 12l5 5l10 -10"/></svg></span>
        </button>
      </div>
  </div>
</div>`);


  var boton = document.getElementById('boton-menu');
  var menu = document.getElementById('menu-usuario');
  if (!boton || !menu) return;

  function abrir(v) {
    menu.hidden = !v;
    boton.setAttribute('aria-expanded', v ? 'true' : 'false');
  }
  boton.addEventListener('click', function (e) { e.stopPropagation(); abrir(menu.hidden); });
  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target)) abrir(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.hidden) { abrir(false); boton.focus(); }
  });

})();
