/* global TrelloPowerUp, GTD_CONFIG */

(function () {
  'use strict';

  // Compute absolute base URL from the connector page location
  // so icon URLs and modal URLs resolve correctly regardless of hosting path.
  var base = window.location.href.replace(/[^/]*$/, '');

  TrelloPowerUp.initialize({

    'board-buttons': function (t) {
      return [
        {
          icon: {
            dark:  base + 'icons/table-dark.svg',
            light: base + 'icons/table-light.svg'
          },
          text: 'Table View',
          callback: function (t) {
            return t.modal({
              url: t.signUrl('./table-view.html'),
              fullscreen: true,
              title: 'GTD Table View'
            });
          }
        }
      ];
    }

  }, {
    appKey: GTD_CONFIG.appKey,
    appName: 'GTD Table View'
  });

}());
