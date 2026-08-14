'use strict';
/*
 * Los folios de las listas de ficheros.
 *
 * Un folio con la esquina doblada y, dentro, lo que caracteriza al tipo:
 * renglones para el texto, cuadricula para la hoja, una diapositiva para la
 * presentacion. El color es el que cada suite ha hecho reconocible —azul el
 * procesador de textos, verde la hoja, naranja la presentacion— y el folio es
 * el mismo para todos, para que la rejilla no parezca un muestrario de estilos.
 *
 * No es una vista previa del contenido: es el documento en si. Saber de un
 * vistazo que hay tres hojas de calculo y un pdf es lo que se busca al mirar
 * una carpeta, y para eso el dibujo del tipo funciona mejor que cuatro
 * miniaturas de folios llenos de letra pequeña.
 *
 * Vive aparte porque documentos y archivos pintan la misma rejilla. Estaba
 * dentro de documentos.html y al llevarlo a archivos habria acabado habiendo
 * dos copias que se separan a la primera correccion.
 *
 * Se dibuja aqui en vez de pedirlo al servidor porque es SVG que escribe este
 * mismo fichero: no hay nada del usuario dentro salvo la extension, que va
 * saneada.
 */
(function () {
  var COLORES = {
    doc:   '#2b579a',
    hoja:  '#217346',
    pres:  '#c43e1c',
    pdf:   '#c8102e',
    txt:   '#5b6472',
    img:   '#7c4dbd',
    zip:   '#b8860b',
    otro:  '#64748b',
  };

  var NOMBRES = {
    doc: 'DOC', hoja: 'XLS', pres: 'PPT', pdf: 'PDF', txt: 'TXT', img: 'IMG', zip: 'ZIP',
  };

  /* Renglones de texto, para el procesador y para el texto plano. */
  function renglones(color, desde, cuantos) {
    var s = '';
    for (var i = 0; i < cuantos; i++) {
      var ancho = i === cuantos - 1 ? 22 : (i % 3 === 1 ? 34 : 40);
      s += '<rect x="12" y="' + (desde + i * 7) + '" width="' + ancho + '" height="3"' +
           ' rx="1.5" fill="' + color + '" opacity=".55"/>';
    }
    return s;
  }

  function celdas(color) {
    var s = '<rect x="11" y="30" width="42" height="9" fill="' + color + '" opacity=".8"/>';
    for (var f = 0; f < 3; f++) {
      for (var c = 0; c < 3; c++) {
        s += '<rect x="' + (11 + c * 14) + '" y="' + (39 + f * 9) + '" width="14" height="9"' +
             ' fill="none" stroke="' + color + '" stroke-width="1" opacity=".45"/>';
      }
    }
    return s;
  }

  function diapositiva(color) {
    return '<rect x="11" y="31" width="42" height="26" rx="2" fill="' + color + '" opacity=".14"/>' +
      '<rect x="11" y="31" width="42" height="26" rx="2" fill="none" stroke="' + color +
      '" stroke-width="1.2" opacity=".7"/>' +
      '<rect x="16" y="36" width="24" height="3.5" rx="1.75" fill="' + color + '" opacity=".8"/>' +
      '<circle cx="18" cy="45" r="1.6" fill="' + color + '" opacity=".6"/>' +
      '<rect x="22" y="43.5" width="20" height="2.6" rx="1.3" fill="' + color + '" opacity=".5"/>' +
      '<circle cx="18" cy="51" r="1.6" fill="' + color + '" opacity=".6"/>' +
      '<rect x="22" y="49.5" width="16" height="2.6" rx="1.3" fill="' + color + '" opacity=".5"/>';
  }

  function paisaje(color) {
    return '<rect x="11" y="31" width="42" height="26" rx="2" fill="' + color + '" opacity=".14"/>' +
      '<circle cx="21" cy="39" r="4" fill="' + color + '" opacity=".65"/>' +
      '<path d="M11 53l11-11 8 8 6-6 17 15v1H11z" fill="' + color + '" opacity=".55"/>' +
      '<rect x="11" y="31" width="42" height="26" rx="2" fill="none" stroke="' + color +
      '" stroke-width="1.2" opacity=".6"/>';
  }

  /* Una cremallera, para lo que viene comprimido. */
  function cremallera(color) {
    var s = '<rect x="27" y="18" width="10" height="34" rx="2" fill="' + color + '" opacity=".18"/>';
    for (var i = 0; i < 5; i++) {
      s += '<rect x="' + (i % 2 ? 27 : 32) + '" y="' + (20 + i * 6) + '" width="5" height="4"' +
           ' fill="' + color + '" opacity=".7"/>';
    }
    return s + '<rect x="28" y="53" width="8" height="10" rx="2" fill="' + color + '" opacity=".8"/>';
  }

  /* Lo que se enseña en el sello de abajo. Para los tipos conocidos, sus tres
     letras de siempre; para el resto, su propia extension, que es justo lo que
     hace falta saber de un .zip o un .iso. */
  function etiquetaDe(clase, ext) {
    if (NOMBRES[clase]) return NOMBRES[clase];
    var e = String(ext || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return e ? e.slice(0, 4) : '';
  }

  function de(clase, ext) {
    var color = COLORES[clase] || COLORES.otro;
    var dentro = clase === 'hoja' ? celdas(color)
      : clase === 'pres' ? diapositiva(color)
        : clase === 'img' ? paisaje(color)
          : clase === 'zip' ? cremallera(color)
            : clase === 'pdf' ? renglones(color, 33, 4)
              : renglones(color, 31, clase === 'txt' ? 6 : 5);

    var etiqueta = etiquetaDe(clase, ext);
    var sello = etiqueta
      ? '<rect x="4" y="60" width="' + (etiqueta.length * 7 + 8) + '" height="13" rx="3" fill="' +
        color + '"/><text x="' + (8 + etiqueta.length * 3.5) + '" y="69.4" text-anchor="middle"' +
        ' font-family="system-ui, sans-serif" font-size="8.5" font-weight="700" fill="#fff">' +
        etiqueta + '</text>'
      : '';

    return '<svg viewBox="0 0 64 80" width="64" height="80" role="img" aria-hidden="true">' +
      /* El folio: esquina doblada arriba a la derecha, que es lo que lo hace
         leerse como un papel y no como un cuadro. */
      '<path d="M6 4a3 3 0 0 1 3-3h29l14 14v57a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z"' +
      ' fill="#fdfdfd" stroke="rgba(0,0,0,.18)" stroke-width="1"/>' +
      '<path d="M38 1l14 14H41a3 3 0 0 1-3-3z" fill="' + color + '" opacity=".22"/>' +
      dentro + sello +
      '</svg>';
  }

  function carpeta() {
    return '<svg viewBox="0 0 64 80" width="64" height="80" role="img" aria-hidden="true">' +
      '<path d="M5 20a3 3 0 0 1 3-3h16l5 6h27a3 3 0 0 1 3 3v37a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"' +
      ' fill="#e9b949" opacity=".9"/>' +
      '<path d="M5 30h54v30a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#f6cf6a"/>' +
      '</svg>';
  }

  function clase(ext) {
    var e = String(ext || '').toLowerCase();
    if (/^(docx?|odt|rtf)$/.test(e)) return 'doc';
    if (/^(xlsx?|ods|csv)$/.test(e)) return 'hoja';
    if (/^(pptx?|odp)$/.test(e)) return 'pres';
    if (e === 'pdf') return 'pdf';
    if (/^(zip|rar|7z|gz|tgz|bz2|xz|tar)$/.test(e)) return 'zip';
    if (/^(txt|md|markdown|log|json|xml|ya?ml|ini|conf|css|js|ts|py|sh|sql|html?)$/.test(e)) return 'txt';
    if (/^(jpe?g|png|gif|webp|avif|heic|tiff?|bmp|svg)$/.test(e)) return 'img';
    return 'otro';
  }


  /* El nombre, a lo que cabe.
     Se recorta por el medio y no por el final para conservar la extension: en
     una rejilla, saber que algo es un .pdf importa tanto como su nombre, y
     «Presupuesto-reforma-cocina-defin…» no dice de que es. El nombre entero
     sale al dejar el cursor encima. */
  function nombreCorto(nombre, cuanto) {
    var max = cuanto || 26;
    var texto = String(nombre || '');
    if (texto.length <= max) return texto;

    var punto = texto.lastIndexOf('.');
    var ext = punto > 0 && texto.length - punto <= 6 ? texto.slice(punto) : '';
    var base = ext ? texto.slice(0, punto) : texto;
    var deja = max - ext.length - 1;

    /* Si la extension es tan larga que no dejaria nombre, se recorta a secas:
       mas vale ver el principio del nombre que solo un punto y su extension. */
    if (deja < 6) return texto.slice(0, max - 1) + '\u2026';
    return base.slice(0, deja) + '\u2026' + ext;
  }

  window.ICONOS = { de: de, carpeta: carpeta, clase: clase,
                    nombreCorto: nombreCorto, COLORES: COLORES };
})();
