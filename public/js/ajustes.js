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
      <a href="https://lepayimio.es/" role="menuitem">Inicio de lepayimio</a>
      <hr>
      <a href="/" role="menuitem">Subir archivo</a>
      <a href="/fotos" role="menuitem">Galería</a>
      <a href="/documentos" role="menuitem">Documentos</a>
      <a href="/archivos" role="menuitem">Archivos</a>
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
          <span class="tema-tic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
        </button>
        <button type="button" class="menu-tema" role="menuitemradio" data-tema="crystal">
          <span class="tema-muestra crystal">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zm0 12.2l7.1-3.95L21 12l-9 5-9-5 1.9-1.05L12 15.2z"/></svg>
          </span>
          <span class="tema-nombre">Crystal</span>
          <span class="tema-tic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
        </button>
        <button type="button" class="menu-tema" role="menuitemradio" data-tema="dark-crystal">
          <span class="tema-muestra dark-crystal">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5zm0 12.2l7.1-3.95L21 12l-9 5-9-5 1.9-1.05L12 15.2z"/></svg>
          </span>
          <span class="tema-nombre">Dark Crystal</span>
          <span class="tema-tic"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
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
