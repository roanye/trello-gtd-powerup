/* global TrelloPowerUp, GTD_CONFIG */

(function () {
  'use strict';

  var t = TrelloPowerUp.iframe({
    appKey: GTD_CONFIG.appKey,
    appName: 'GTD Table View'
  });

  // ─── Constants ─────────────────────────────────────────────────────────────

  var TRELLO_API = 'https://api.trello.com/1';

  var STANDARD_COLUMNS = [
    { id: 'name',    label: 'Name',     visible: true,  sortable: true,  type: 'link',     minWidth: 260, native: true },
    { id: 'list',    label: 'List',     visible: true,  sortable: true,  type: 'list-edit', minWidth: 140, native: true },
    { id: 'labels',  label: 'Labels',   visible: true,  sortable: false, type: 'labels',   minWidth: 180, native: true },
    { id: 'due',     label: 'Due Date', visible: true,  sortable: true,  type: 'date',     minWidth: 100, native: true },
    { id: 'members', label: 'Members',  visible: false, sortable: false, type: 'members',  minWidth: 120, native: true }
  ];

  // Trello label color name → hex.
  // Also used for custom field list option colors.
  var LABEL_HEX = {
    'red':          '#c9372c', 'red_dark':    '#ae2e24',
    'orange':       '#cf6f17', 'orange_dark': '#c25100',
    'yellow':       '#e2b203', 'yellow_dark': '#946f00',
    'green':        '#4bce97', 'green_dark':  '#1f845a',
    'blue':         '#579dff', 'blue_dark':   '#0c66e4',
    'purple':       '#9f8fef', 'purple_dark': '#6e5dc6',
    'pink':         '#f87168', 'pink_dark':   '#ae2e24',
    'sky':          '#6cc3e0', 'sky_dark':    '#227d9b',
    'lime':         '#94c748', 'lime_dark':   '#5b7f24',
    'black':        '#8590a2', 'black_dark':  '#626f86',
    'null':         '#8590a2'
  };

  // ─── State ─────────────────────────────────────────────────────────────────

  var state = {
    cards:          [],
    lists:          {},   // idList → name
    listPos:        {},   // idList → numeric index (board order)
    members:        {},   // idMember → fullName
    customFields:   [],   // [{id, name, type, options:[{id, value:{text}, color, pos}]}]
    cardFieldItems: {},   // cardId → { cfId → {idCustomField, idValue?, value?} }
    columns:        [],   // built dynamically after load
    columnPrefs:    {},   // colId → visible boolean (saved to t.set member private)
    sort:           { column: null, dir: 'asc' },
    filters:        { search: '', lists: [] },  // lists: array of selected list IDs
    apiToken:       null,
    boardLabels:    []   // all labels defined on the board
  };

  var _popoverTd = null;

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  t.render(function () {
    showLoading(true);

    return Promise.all([loadPreferences(), t.get('member', 'private', 'gtdApiToken')])
      .then(function (results) {
        var savedToken = results[1];
        if (savedToken) {
          state.apiToken = savedToken;
          return loadData().then(function () {
            showLoading(false);
            buildUI();
          });
        } else {
          showLoading(false);
          showAuthOverlay();
        }
      })
      .catch(function (err) {
        showLoading(false);
        showError('Failed to initialize: ' + (err && err.message ? err.message : String(err)));
      });
  });

  // ─── Auth Overlay ──────────────────────────────────────────────────────────
  // Uses direct Trello OAuth instead of t.getRestApi() to avoid SDK scope issues.

  function showAuthOverlay() {
    var overlay = document.getElementById('auth-overlay');
    if (overlay) overlay.classList.remove('hidden');

    var authBtn = document.getElementById('auth-btn');
    if (!authBtn) return;

    authBtn.addEventListener('click', function () {
      var callbackUrl = 'https://roanye.github.io/trello-gtd-powerup/auth-callback.html';
      var authUrl = 'https://trello.com/1/authorize'
        + '?key='          + GTD_CONFIG.appKey
        + '&name='         + encodeURIComponent('GTD Table View')
        + '&scope=read%2Cwrite'
        + '&expiration=never'
        + '&response_type=token'
        + '&return_url='   + encodeURIComponent(callbackUrl);

      try { localStorage.removeItem('gtd_trello_token_pending'); } catch(e) {}

      var popup = window.open(authUrl, 'trello_auth', 'width=520,height=700,left=200,top=80');

      // Listen for postMessage from auth-callback.html
      function onMessage(e) {
        if (e.data && e.data.gtdToken) {
          window.removeEventListener('message', onMessage);
          clearInterval(pollInterval);
          handleToken(e.data.gtdToken);
        }
      }
      window.addEventListener('message', onMessage);

      // Fallback: poll localStorage (for browsers that block postMessage cross-frame)
      var pollInterval = setInterval(function () {
        var token;
        try { token = localStorage.getItem('gtd_trello_token_pending'); } catch(e) {}
        if (token) {
          clearInterval(pollInterval);
          window.removeEventListener('message', onMessage);
          try { localStorage.removeItem('gtd_trello_token_pending'); } catch(e) {}
          handleToken(token);
          return;
        }
        if (popup && popup.closed) {
          clearInterval(pollInterval);
          window.removeEventListener('message', onMessage);
        }
      }, 500);

      function handleToken(token) {
        state.apiToken = token;
        t.set('member', 'private', 'gtdApiToken', token).catch(function () {});
        hideAuthOverlay();
        showLoading(true);
        loadData().then(function () {
          showLoading(false);
          buildUI();
        }).catch(function (err) {
          showLoading(false);
          showError('Load failed: ' + (err && err.message ? err.message : String(err)));
        });
      }
    });
  }

  function hideAuthOverlay() {
    var overlay = document.getElementById('auth-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  // ─── Preferences ───────────────────────────────────────────────────────────

  function loadPreferences() {
    return t.get('member', 'private', 'gtdTablePrefs')
      .then(function (prefs) {
        if (!prefs) return;
        if (prefs.columnPrefs) state.columnPrefs = prefs.columnPrefs;
        if (prefs.sort) state.sort = prefs.sort;
      })
      .catch(function () { /* missing prefs is acceptable */ });
  }

  function savePreferences() {
    t.set('member', 'private', 'gtdTablePrefs', {
      columnPrefs: state.columnPrefs,
      sort: state.sort
    }).catch(function () {});
  }

  // ─── Data Loading ──────────────────────────────────────────────────────────

  function loadData() {
    return t.board('id')
      .then(function (board) {
        var boardId = board.id;
        var url = TRELLO_API + '/boards/' + boardId
          + '?cards=open'
          + '&card_customFieldItems=true'
          + '&card_fields=id,name,idList,labels,due,dueComplete,idMembers,pos,closed,shortLink'
          + '&customFields=true'
          + '&lists=open'
          + '&list_fields=id,name,pos'
          + '&members=all'
          + '&member_fields=id,fullName,username'
          + '&labels=all'
          + '&label_fields=id,name,color'
          + '&key=' + GTD_CONFIG.appKey
          + '&token=' + state.apiToken;

        return fetch(url);
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Trello API returned HTTP ' + response.status);
        }
        return response.json();
      })
      .then(function (board) {
        // Sort lists by board position
        var sortedLists = (board.lists || []).slice().sort(function (a, b) {
          return a.pos - b.pos;
        });

        state.lists   = {};
        state.listPos = {};
        state.members = {};

        sortedLists.forEach(function (list, idx) {
          state.lists[list.id]   = list.name;
          state.listPos[list.id] = idx;
        });

        (board.members || []).forEach(function (m) {
          state.members[m.id] = m.fullName || m.username;
        });

        // Filter to non-closed open cards only
        state.cards = (board.cards || []).filter(function (c) {
          return !c.closed;
        });

        // Parse custom fields — sort options by pos for consistent dropdown order
        state.customFields = (board.customFields || []).map(function (cf) {
          var options = (cf.options || []).slice().sort(function (a, b) {
            return (a.pos || 0) - (b.pos || 0);
          });
          return {
            id:      cf.id,
            name:    cf.name,
            type:    cf.type,
            options: options
          };
        });

        // Index each card's custom field items by field id
        state.cardFieldItems = {};
        state.cards.forEach(function (card) {
          state.cardFieldItems[card.id] = {};
          (card.customFieldItems || []).forEach(function (item) {
            state.cardFieldItems[card.id][item.idCustomField] = item;
          });
        });

        // Populate list filter dropdown in board order
        var listSelect = document.getElementById('list-filter');
        if (listSelect) {
          listSelect.innerHTML = '<option value="">All Lists</option>';
          sortedLists.forEach(function (list) {
            var opt = document.createElement('option');
            opt.value = list.id;
            opt.textContent = list.name;
            listSelect.appendChild(opt);
          });
        }

        state.boardLabels = (board.labels || []);
        buildColumns();
      });
  }

  // ─── Column Construction ───────────────────────────────────────────────────

  function buildColumns() {
    var prefs = state.columnPrefs;

    // Start with standard columns, applying any saved visibility preference
    var cols = STANDARD_COLUMNS.map(function (c) {
      var copy = Object.assign({}, c);
      if (prefs[c.id] !== undefined) copy.visible = prefs[c.id];
      return copy;
    });

    // Append one column per custom field
    state.customFields.forEach(function (cf) {
      var colId = 'cf_' + cf.id;
      cols.push({
        id:       colId,
        label:    cf.name,
        visible:  prefs[colId] !== undefined ? prefs[colId] : true,
        sortable: true,
        type:     'customField',
        minWidth: 150,
        native:   false,
        cf:       cf
      });
    });

    state.columns = cols;
  }

  // ─── UI Construction ───────────────────────────────────────────────────────

  function buildUI() {
    attachToolbarListeners();
    buildListFilterDropdown();
    renderTable();
    buildColumnDropdown();
    setupPopoverDismiss();
  }

  function renderTable() {
    renderHeader();
    renderTableBody();
  }

  // ─── Header ────────────────────────────────────────────────────────────────

  function renderHeader() {
    var row = document.getElementById('header-row');
    if (!row) return;
    row.innerHTML = '';

    visibleColumns().forEach(function (col) {
      var th = document.createElement('th');
      th.dataset.colId = col.id;
      th.style.minWidth = col.minWidth + 'px';

      var inner = document.createElement('div');
      inner.className = 'th-inner';

      var label = document.createElement('span');
      label.className = 'col-label';
      label.textContent = col.label;
      inner.appendChild(label);

      if (col.sortable) {
        var arrow = document.createElement('span');
        arrow.className = 'sort-icon' + (state.sort.column === col.id ? ' active' : '');
        arrow.textContent = state.sort.column === col.id
          ? (state.sort.dir === 'asc' ? ' \u25b2' : ' \u25bc')
          : ' \u21c5';
        inner.appendChild(arrow);

        th.style.cursor = 'pointer';
        th.addEventListener('click', (function (colId) {
          return function () {
            if (state.sort.column === colId) {
              if (state.sort.dir === 'asc') {
                state.sort.dir = 'desc';
              } else {
                // Third click: clear sort, return to board order
                state.sort.column = null;
                state.sort.dir = 'asc';
              }
            } else {
              state.sort.column = colId;
              state.sort.dir = 'asc';
            }
            savePreferences();
            renderTable();
          };
        }(col.id)));
      }

      th.appendChild(inner);
      row.appendChild(th);
    });
  }

  // ─── Body ──────────────────────────────────────────────────────────────────

  function renderTableBody() {
    var tbody = document.getElementById('table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    var cards = filteredSortedCards();
    var cols  = visibleColumns();

    if (cards.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = cols.length;
      emptyCell.className = 'empty-state';
      emptyCell.textContent = 'No cards match your filters.';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }

    cards.forEach(function (card) {
      var tr = document.createElement('tr');
      tr.dataset.cardId = card.id;

      cols.forEach(function (col) {
        var td = document.createElement('td');
        renderCell(td, card, col);
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  }

  // ─── Cell Rendering ────────────────────────────────────────────────────────

  function renderCell(td, card, col) {
    // Clear any previous content when re-rendering a single cell
    td.innerHTML = '';
    td.className = '';

    switch (col.type) {

      case 'link':
        td.className = '';
        var nameWrapper = document.createElement('div');
        nameWrapper.className = 'cell-name';
        var completeBtn = document.createElement('span');
        completeBtn.className = 'completion-btn';
        completeBtn.title = 'Archive card';
        completeBtn.onclick = (function (c) {
          return function (e) { e.stopPropagation(); archiveCard(c); };
        }(card));
        var nameLink = document.createElement('a');
        nameLink.className = 'card-name-link';
        nameLink.href = '#';
        nameLink.title = card.name;
        nameLink.textContent = card.name;
        nameLink.addEventListener('click', function (e) {
          e.preventDefault();
          window.open('https://trello.com/c/' + card.shortLink, '_blank');
        });
        nameWrapper.appendChild(completeBtn);
        nameWrapper.appendChild(nameLink);
        td.appendChild(nameWrapper);
        break;

      case 'list-edit':
        td.className = 'cell-editable';
        attachListEditor(td, card);
        break;

      case 'labels':
        td.className = 'cell-editable';
        attachLabelsEditor(td, card);
        break;

      case 'date':
        td.className = 'cell-editable';
        attachDateEditor(td, card);
        break;

      case 'members':
        td.className = 'cell-editable';
        attachMembersEditor(td, card);
        break;

      case 'customField':
        renderCustomFieldCell(td, card, col);
        break;
    }
  }

  // ─── Custom Field Cell Dispatch ────────────────────────────────────────────

  function renderCustomFieldCell(td, card, col) {
    var cf   = col.cf;
    var item = (state.cardFieldItems[card.id] || {})[cf.id];

    switch (cf.type) {
      case 'text':
        td.className = 'cell-editable cell-text';
        attachTextCFEditor(td, card, cf, item && item.value ? (item.value.text || '') : '');
        break;

      case 'number':
        td.className = 'cell-editable cell-number';
        attachNumberCFEditor(td, card, cf, item && item.value ? (item.value.number || '') : '');
        break;

      case 'date':
        td.className = 'cell-date';
        if (item && item.value && item.value.date) {
          var dateParsed = new Date(item.value.date);
          td.textContent = dateParsed.toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric'
          });
        } else {
          td.textContent = '';
        }
        break;

      case 'list':
        td.className = 'cell-editable cell-cf-list';
        attachListCFEditor(td, card, cf, item ? (item.idValue || '') : '');
        break;

      case 'checkbox':
        td.className = 'cell-editable cell-cf-checkbox';
        var checked = item && item.value && item.value.checked === 'true';
        attachCheckboxCFEditor(td, card, cf, checked);
        break;

      default:
        td.className = 'cell-readonly';
        td.textContent = '';
        break;
    }
  }

  // ─── Text Custom Field Editor ──────────────────────────────────────────────

  function attachTextCFEditor(td, card, cf, initialValue) {
    var currentValue = initialValue;

    function showDisplay() {
      td.innerHTML = '';
      var span = document.createElement('span');
      span.className = 'cell-display';
      span.textContent = currentValue;
      if (!currentValue) span.classList.add('empty');
      td.appendChild(span);
    }

    function showEditor() {
      td.innerHTML = '';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'cell-input';
      input.value = currentValue;
      td.appendChild(input);
      input.focus();
      input.select();

      function commit() {
        var next = input.value.trim();
        if (next !== currentValue) {
          currentValue = next;
          saveCustomFieldValue(card, cf, { value: { text: next } });
        }
        showDisplay();
      }

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter')  { input.blur(); }
        if (e.key === 'Escape') { input.value = currentValue; input.blur(); }
        e.stopPropagation();
      });
    }

    td.onclick = function () {
      if (!td.querySelector('input')) showEditor();
    };

    showDisplay();
  }

  // ─── Number Custom Field Editor ────────────────────────────────────────────

  function attachNumberCFEditor(td, card, cf, initialValue) {
    var currentValue = String(initialValue);

    function showDisplay() {
      td.innerHTML = '';
      var span = document.createElement('span');
      span.className = 'cell-display';
      span.textContent = currentValue;
      if (!currentValue) span.classList.add('empty');
      td.appendChild(span);
    }

    function showEditor() {
      td.innerHTML = '';
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'cell-input';
      input.value = currentValue;
      td.appendChild(input);
      input.focus();
      input.select();

      function commit() {
        var next = input.value.trim();
        if (next !== currentValue) {
          currentValue = next;
          saveCustomFieldValue(card, cf, { value: { number: next } });
        }
        showDisplay();
      }

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter')  { input.blur(); }
        if (e.key === 'Escape') { input.value = currentValue; input.blur(); }
        e.stopPropagation();
      });
    }

    td.onclick = function () {
      if (!td.querySelector('input')) showEditor();
    };

    showDisplay();
  }

  // ─── List (Dropdown) Custom Field Editor ───────────────────────────────────

  function attachListCFEditor(td, card, cf, currentIdValue) {
    function showDisplay() {
      td.innerHTML = '';
      if (currentIdValue) {
        var selectedOption = null;
        for (var i = 0; i < cf.options.length; i++) {
          if (cf.options[i].id === currentIdValue) {
            selectedOption = cf.options[i];
            break;
          }
        }
        if (selectedOption) {
          var badge = document.createElement('span');
          badge.className = 'status-badge';
          badge.textContent = selectedOption.value.text;
          var hex = cfOptionColorToHex(selectedOption.color);
          badge.style.backgroundColor = hex;
          badge.style.color = isLightHex(hex) ? '#1d2125' : '#ffffff';
          td.appendChild(badge);
          return;
        }
      }
      var empty = document.createElement('span');
      empty.className = 'cell-display empty';
      td.appendChild(empty);
    }

    td.onclick = function (e) {
      e.stopPropagation();
      if (_popoverTd === td) { closePopover(); return; }
      openPopover(td, function (popover) {
        // None option
        var noneItem = document.createElement('div');
        noneItem.className = 'popover-item' + (!currentIdValue ? ' selected' : '');
        noneItem.textContent = '— None —';
        noneItem.addEventListener('click', function (e) {
          e.stopPropagation();
          if (currentIdValue !== '') {
            currentIdValue = '';
            saveCustomFieldValue(card, cf, { idValue: '' });
          }
          showDisplay();
          closePopover();
        });
        popover.appendChild(noneItem);

        cf.options.forEach(function (opt) {
          var item = document.createElement('div');
          item.className = 'popover-item' + (opt.id === currentIdValue ? ' selected' : '');
          var badge = document.createElement('span');
          badge.className = 'status-badge';
          badge.textContent = opt.value.text;
          var hex = cfOptionColorToHex(opt.color);
          badge.style.backgroundColor = hex;
          badge.style.color = isLightHex(hex) ? '#1d2125' : '#ffffff';
          item.appendChild(badge);
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            if (opt.id !== currentIdValue) {
              currentIdValue = opt.id;
              saveCustomFieldValue(card, cf, { idValue: opt.id });
            }
            showDisplay();
            closePopover();
          });
          popover.appendChild(item);
        });
      });
    };

    showDisplay();
  }

  // ─── Checkbox Custom Field Editor ──────────────────────────────────────────

  function attachCheckboxCFEditor(td, card, cf, initialChecked) {
    var checked = initialChecked;

    function showDisplay() {
      td.innerHTML = '';
      var box = document.createElement('span');
      box.className = 'cf-checkbox' + (checked ? ' checked' : '');
      box.textContent = checked ? '\u2713' : '';
      td.appendChild(box);
    }

    td.onclick = function () {
      checked = !checked;
      saveCustomFieldValue(card, cf, { value: { checked: checked ? 'true' : 'false' } });
      showDisplay();
    };

    showDisplay();
  }

  // ─── Custom Field API Save ─────────────────────────────────────────────────

  function saveCustomFieldValue(card, cf, payload) {
    var url = TRELLO_API + '/cards/' + card.id + '/customField/' + cf.id + '/item'
      + '?key=' + GTD_CONFIG.appKey + '&token=' + state.apiToken;

    fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        // Merge saved payload into local state so sort/filter picks it up
        if (!state.cardFieldItems[card.id]) {
          state.cardFieldItems[card.id] = {};
        }
        var existing = state.cardFieldItems[card.id][cf.id] || { idCustomField: cf.id };
        if (payload.idValue !== undefined) {
          existing.idValue = payload.idValue;
          // Clear value field when using idValue (list type)
          delete existing.value;
        } else if (payload.value !== undefined) {
          existing.value = payload.value;
          delete existing.idValue;
        }
        state.cardFieldItems[card.id][cf.id] = existing;
      })
      .catch(function (err) {
        console.error('[GTD Table] save failed for card ' + card.id + ' field ' + cf.id, err);
      });
  }

  // ─── Generic API Helper ────────────────────────────────────────────────────

  function apiPut(path, body) {
    return fetch(TRELLO_API + path + '?key=' + GTD_CONFIG.appKey + '&token=' + state.apiToken, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiPost(path, body) {
    return fetch(TRELLO_API + path + '?key=' + GTD_CONFIG.appKey + '&token=' + state.apiToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiDelete(path) {
    return fetch(TRELLO_API + path + '?key=' + GTD_CONFIG.appKey + '&token=' + state.apiToken, {
      method: 'DELETE'
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.ok;
    });
  }

  // ─── Label Chip ────────────────────────────────────────────────────────────

  function makeLabelChip(label) {
    var chip = document.createElement('span');
    chip.className = 'label-chip';
    var hex = LABEL_HEX[label.color] || LABEL_HEX['null'];
    chip.style.backgroundColor = hex;
    chip.style.color = isLightHex(hex) ? '#1d2125' : '#ffffff';
    chip.textContent = label.name || '';
    chip.title = label.name || '';
    return chip;
  }

  // ─── Color Helpers ─────────────────────────────────────────────────────────

  function cfOptionColorToHex(color) {
    if (!color) return LABEL_HEX['null'];
    // Trello custom field option colors may come back as e.g. "green" or "green_dark"
    return LABEL_HEX[color] || LABEL_HEX['null'];
  }

  function isLightHex(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
  }

  // ─── Filtering & Sorting ──────────────────────────────────────────────────

  function filteredSortedCards() {
    var cards = state.cards.slice();
    var f = state.filters;

    if (f.search) {
      var q = f.search.toLowerCase();
      cards = cards.filter(function (card) {
        // Search card name
        if (card.name.toLowerCase().indexOf(q) !== -1) return true;

        // Search text and number custom field values
        var fieldItems = state.cardFieldItems[card.id] || {};
        for (var i = 0; i < state.customFields.length; i++) {
          var cf = state.customFields[i];
          var item = fieldItems[cf.id];
          if (!item || !item.value) continue;
          if (cf.type === 'text' && item.value.text) {
            if (item.value.text.toLowerCase().indexOf(q) !== -1) return true;
          }
          if (cf.type === 'number' && item.value.number) {
            if (String(item.value.number).toLowerCase().indexOf(q) !== -1) return true;
          }
        }
        return false;
      });
    }

    if (f.lists && f.lists.length > 0) {
      cards = cards.filter(function (card) { return f.lists.indexOf(card.idList) !== -1; });
    }

    if (state.sort.column) {
      var sortColId = state.sort.column;
      var dir = state.sort.dir === 'asc' ? 1 : -1;

      // Resolve the column object once so custom field lookups have the cf reference
      var sortCol = null;
      for (var ci = 0; ci < state.columns.length; ci++) {
        if (state.columns[ci].id === sortColId) {
          sortCol = state.columns[ci];
          break;
        }
      }

      cards.sort(function (a, b) {
        var av = sortValue(a, sortColId, sortCol);
        var bv = sortValue(b, sortColId, sortCol);
        if (av < bv) return -1 * dir;
        if (av > bv) return  1 * dir;
        return 0;
      });
    } else {
      // Default: mirror board view — list order, then card position within list
      cards.sort(function (a, b) {
        var listDiff = (state.listPos[a.idList] || 0) - (state.listPos[b.idList] || 0);
        if (listDiff !== 0) return listDiff;
        return (a.pos || 0) - (b.pos || 0);
      });
    }

    return cards;
  }

  function sortValue(card, colId, col) {
    switch (colId) {
      case 'name':    return card.name.toLowerCase();
      case 'list':    return state.listPos[card.idList] !== undefined ? state.listPos[card.idList] : 999;
      case 'due':     return card.due || 'zzz';
      default:
        // Custom field columns
        if (col && col.type === 'customField') {
          var cf = col.cf;
          var item = (state.cardFieldItems[card.id] || {})[cf.id];
          if (!item) return 'zzz';

          switch (cf.type) {
            case 'text':
              return (item.value && item.value.text || '').toLowerCase();
            case 'number':
              return parseFloat(item.value && item.value.number) || 0;
            case 'list':
              var matchedOpt = null;
              for (var oi = 0; oi < cf.options.length; oi++) {
                if (cf.options[oi].id === item.idValue) {
                  matchedOpt = cf.options[oi];
                  break;
                }
              }
              return matchedOpt ? matchedOpt.value.text.toLowerCase() : 'zzz';
            case 'checkbox':
              return item.value && item.value.checked === 'true' ? 0 : 1;
            default:
              return '';
          }
        }
        return '';
    }
  }

  // ─── Toolbar Listeners ────────────────────────────────────────────────────

  function attachToolbarListeners() {
    var searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        state.filters.search = this.value;
        renderTableBody();
      });
    }

    var clearBtn = document.getElementById('clear-filters-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state.filters = { search: '', lists: [] };
        var si = document.getElementById('search-input');
        if (si) si.value = '';
        updateListFilterBtn();
        // Uncheck all list checkboxes
        var dd = document.getElementById('list-filter-dropdown');
        if (dd) {
          dd.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
        }
        renderTableBody();
      });
    }

    var refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        showLoading(true);
        loadData()
          .then(function () {
            showLoading(false);
            buildListFilterDropdown();
            renderTable();
            buildColumnDropdown();
          })
          .catch(function (err) {
            showLoading(false);
            showError('Refresh failed: ' + (err && err.message ? err.message : String(err)));
          });
      });
    }
  }

  // ─── Column Toggle Dropdown ───────────────────────────────────────────────

  function buildColumnDropdown() {
    var dropdown = document.getElementById('columns-dropdown');
    var btn      = document.getElementById('columns-btn');
    if (!dropdown || !btn) return;

    dropdown.innerHTML = '';

    state.columns.forEach(function (col) {
      var lbl = document.createElement('label');
      lbl.className = 'col-toggle-item';

      var cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = col.visible;

      cb.addEventListener('change', (function (targetCol, checkbox) {
        return function () {
          targetCol.visible = checkbox.checked;
          state.columnPrefs[targetCol.id] = targetCol.visible;
          savePreferences();
          renderTable();
        };
      }(col, cb)));

      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + col.label));
      dropdown.appendChild(lbl);
    });

    // Only attach the click listeners once; check for a flag to avoid duplicates
    if (!btn.dataset.listenerAttached) {
      btn.dataset.listenerAttached = 'true';

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
      });

      document.addEventListener('click', function () {
        dropdown.classList.add('hidden');
      });

      dropdown.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
  }

  // ─── List Filter Multi-Select Dropdown ───────────────────────────────────

  function buildListFilterDropdown() {
    var btn      = document.getElementById('list-filter-btn');
    var dropdown = document.getElementById('list-filter-dropdown');
    if (!btn || !dropdown) return;

    dropdown.innerHTML = '';

    // Build a checkbox per list in board order
    Object.keys(state.listPos)
      .sort(function (a, b) { return state.listPos[a] - state.listPos[b]; })
      .forEach(function (listId) {
        var lbl = document.createElement('label');
        lbl.className = 'col-toggle-item';

        var cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.value   = listId;
        cb.checked = state.filters.lists.indexOf(listId) !== -1;

        cb.addEventListener('change', function () {
          if (cb.checked) {
            if (state.filters.lists.indexOf(listId) === -1) {
              state.filters.lists.push(listId);
            }
          } else {
            state.filters.lists = state.filters.lists.filter(function (id) { return id !== listId; });
          }
          updateListFilterBtn();
          renderTableBody();
        });

        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + (state.lists[listId] || listId)));
        dropdown.appendChild(lbl);
      });

    // Attach toggle listeners once
    if (!btn.dataset.listFilterListenerAttached) {
      btn.dataset.listFilterListenerAttached = 'true';

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
      });

      document.addEventListener('click', function () {
        dropdown.classList.add('hidden');
      });

      dropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    }
  }

  function updateListFilterBtn() {
    var btn = document.getElementById('list-filter-btn');
    if (!btn) return;
    var sel = state.filters.lists;
    if (sel.length === 0) {
      btn.textContent = 'All Lists ▾';
    } else if (sel.length === 1) {
      btn.textContent = (state.lists[sel[0]] || 'List') + ' ▾';
    } else {
      btn.textContent = sel.length + ' Lists ▾';
    }
  }

  // ─── Card Archive (Complete) ──────────────────────────────────────────────

  function archiveCard(card) {
    var url = TRELLO_API + '/cards/' + card.id
      + '?key=' + GTD_CONFIG.appKey + '&token=' + state.apiToken;

    fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closed: true })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        state.cards = state.cards.filter(function (c) { return c.id !== card.id; });
        renderTableBody();
      })
      .catch(function (err) {
        console.error('[GTD Table] Archive failed', err);
      });
  }

  // ─── List Editor ──────────────────────────────────────────────────────────

  function attachListEditor(td, card) {
    var currentListId = card.idList;

    function showDisplay() {
      td.innerHTML = '';
      var span = document.createElement('span');
      span.className = 'cell-display';
      span.textContent = state.lists[currentListId] || '';
      td.appendChild(span);
    }

    td.onclick = function (e) {
      e.stopPropagation();
      if (_popoverTd === td) { closePopover(); return; }
      openPopover(td, function (popover) {
        var header = document.createElement('div');
        header.className = 'popover-header';
        header.textContent = 'Move to list';
        popover.appendChild(header);

        Object.keys(state.listPos)
          .sort(function (a, b) { return state.listPos[a] - state.listPos[b]; })
          .forEach(function (listId) {
            var item = document.createElement('div');
            item.className = 'popover-item' + (listId === currentListId ? ' selected' : '');
            item.textContent = state.lists[listId] || listId;
            item.addEventListener('click', function (e) {
              e.stopPropagation();
              if (listId !== currentListId) {
                currentListId = listId;
                card.idList = listId;
                apiPut('/cards/' + card.id, { idList: listId })
                  .catch(function (err) { console.error('[GTD Table] List change failed', err); });
              }
              showDisplay();
              closePopover();
            });
            popover.appendChild(item);
          });
      });
    };

    showDisplay();
  }

  // ─── Labels Editor ────────────────────────────────────────────────────────

  function attachLabelsEditor(td, card) {
    function showDisplay() {
      td.innerHTML = '';
      var wrap = document.createElement('div');
      wrap.className = 'cell-labels';
      if ((card.labels || []).length > 0) {
        card.labels.forEach(function (lbl) { wrap.appendChild(makeLabelChip(lbl)); });
      } else {
        var empty = document.createElement('span');
        empty.className = 'cell-display empty';
        wrap.appendChild(empty);
      }
      td.appendChild(wrap);
    }

    td.onclick = function (e) {
      e.stopPropagation();
      if (_popoverTd === td) { closePopover(); return; }
      openLabelsPopover(td, card, showDisplay);
    };

    showDisplay();
  }

  // ─── Members Editor ───────────────────────────────────────────────────────

  function attachMembersEditor(td, card) {
    function showDisplay() {
      td.innerHTML = '';
      var wrap = document.createElement('div');
      wrap.className = 'cell-members';
      if ((card.idMembers || []).length > 0) {
        card.idMembers.forEach(function (mid) {
          var fullName = state.members[mid];
          if (!fullName) return;
          var initials = fullName.split(' ').map(function (n) { return n[0]; }).join('').toUpperCase().slice(0, 2);
          var avatar = document.createElement('span');
          avatar.className = 'member-avatar';
          avatar.textContent = initials;
          avatar.title = fullName;
          wrap.appendChild(avatar);
        });
      } else {
        var empty = document.createElement('span');
        empty.className = 'cell-display empty';
        wrap.appendChild(empty);
      }
      td.appendChild(wrap);
    }

    td.onclick = function (e) {
      e.stopPropagation();
      if (_popoverTd === td) { closePopover(); return; }
      openMembersPopover(td, card, showDisplay);
    };

    showDisplay();
  }

  // ─── Date Editor ──────────────────────────────────────────────────────────

  function attachDateEditor(td, card) {
    function showDisplay() {
      td.innerHTML = '';
      td.className = 'cell-editable';
      if (card.due) {
        var d = new Date(card.due);
        var span = document.createElement('span');
        span.className = 'cell-date';
        span.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        if (card.dueComplete) {
          span.classList.add('due-complete');
        } else if (d < new Date()) {
          span.classList.add('due-overdue');
        }
        td.appendChild(span);
      } else {
        var empty = document.createElement('span');
        empty.className = 'cell-display empty';
        td.appendChild(empty);
      }
    }

    td.onclick = function (e) {
      e.stopPropagation();
      if (_popoverTd === td) { closePopover(); return; }
      openDatePopover(td, card, showDisplay);
    };

    showDisplay();
  }

  // ─── Popover Management ───────────────────────────────────────────────────

  function openPopover(td, buildFn) {
    closePopover();
    var popover = document.getElementById('cell-popover');
    if (!popover) return;

    _popoverTd = td;
    popover.innerHTML = '';
    popover.style.padding = '';
    popover.style.minWidth = '';
    buildFn(popover);

    var rect = td.getBoundingClientRect();
    var left = rect.left;
    var top  = rect.bottom + 4;

    // Keep within right edge
    if (left + 280 > window.innerWidth - 8) {
      left = window.innerWidth - 288;
    }
    // Keep within bottom edge
    if (top + 340 > window.innerHeight - 8) {
      top = rect.top - 4;
      popover.style.transform = 'translateY(-100%)';
    } else {
      popover.style.transform = '';
    }

    popover.style.left = left + 'px';
    popover.style.top  = top  + 'px';
    popover.classList.remove('hidden');
  }

  function closePopover() {
    var popover = document.getElementById('cell-popover');
    if (!popover || popover.classList.contains('hidden')) return;
    popover.classList.add('hidden');
    popover.innerHTML = '';
    popover.style.transform = '';
    _popoverTd = null;
  }

  function setupPopoverDismiss() {
    if (document._gtdPopoverDismiss) return;
    document._gtdPopoverDismiss = true;

    document.addEventListener('click', function (e) {
      var popover = document.getElementById('cell-popover');
      if (popover && !popover.classList.contains('hidden') && !popover.contains(e.target)) {
        closePopover();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePopover();
    });
  }

  // ─── Labels Popover ───────────────────────────────────────────────────────

  function openLabelsPopover(td, card, onUpdate) {
    openPopover(td, function (popover) {
      var header = document.createElement('div');
      header.className = 'popover-header';
      header.textContent = 'Labels';
      popover.appendChild(header);

      if (state.boardLabels.length === 0) {
        var empty = document.createElement('div');
        empty.style.padding = '6px 14px';
        empty.style.color = 'var(--text-muted)';
        empty.textContent = 'No labels on this board.';
        popover.appendChild(empty);
        return;
      }

      state.boardLabels.forEach(function (lbl) {
        var isChecked = (card.labels || []).some(function (l) { return l.id === lbl.id; });

        var item = document.createElement('label');
        item.className = 'col-toggle-item';

        var cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = isChecked;
        cb.addEventListener('change', function () {
          if (cb.checked) {
            apiPost('/cards/' + card.id + '/idLabels', { value: lbl.id })
              .then(function () {
                if (!card.labels) card.labels = [];
                if (!card.labels.some(function (l) { return l.id === lbl.id; })) {
                  card.labels.push({ id: lbl.id, name: lbl.name, color: lbl.color });
                }
                onUpdate();
              })
              .catch(function (err) { console.error('[GTD] Add label failed', err); cb.checked = false; });
          } else {
            apiDelete('/cards/' + card.id + '/idLabels/' + lbl.id)
              .then(function () {
                card.labels = (card.labels || []).filter(function (l) { return l.id !== lbl.id; });
                onUpdate();
              })
              .catch(function (err) { console.error('[GTD] Remove label failed', err); cb.checked = true; });
          }
        });

        var chip = makeLabelChip(lbl);
        chip.style.flexShrink = '0';

        item.appendChild(cb);
        item.appendChild(chip);
        if (lbl.name) {
          var nameSpan = document.createElement('span');
          nameSpan.textContent = lbl.name;
          nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          item.appendChild(nameSpan);
        }
        popover.appendChild(item);
      });
    });
  }

  // ─── Members Popover ──────────────────────────────────────────────────────

  function openMembersPopover(td, card, onUpdate) {
    openPopover(td, function (popover) {
      var header = document.createElement('div');
      header.className = 'popover-header';
      header.textContent = 'Members';
      popover.appendChild(header);

      Object.keys(state.members).forEach(function (memberId) {
        var fullName = state.members[memberId];
        var isChecked = (card.idMembers || []).indexOf(memberId) !== -1;

        var item = document.createElement('label');
        item.className = 'col-toggle-item';

        var cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = isChecked;
        cb.addEventListener('change', function () {
          if (cb.checked) {
            apiPost('/cards/' + card.id + '/idMembers', { value: memberId })
              .then(function () {
                if (!card.idMembers) card.idMembers = [];
                if (card.idMembers.indexOf(memberId) === -1) card.idMembers.push(memberId);
                onUpdate();
              })
              .catch(function (err) { console.error('[GTD] Add member failed', err); cb.checked = false; });
          } else {
            apiDelete('/cards/' + card.id + '/idMembers/' + memberId)
              .then(function () {
                card.idMembers = (card.idMembers || []).filter(function (id) { return id !== memberId; });
                onUpdate();
              })
              .catch(function (err) { console.error('[GTD] Remove member failed', err); cb.checked = true; });
          }
        });

        var initials = fullName.split(' ').map(function (n) { return n[0]; }).join('').toUpperCase().slice(0, 2);
        var avatar = document.createElement('span');
        avatar.className = 'member-avatar';
        avatar.textContent = initials;
        avatar.title = fullName;
        avatar.style.flexShrink = '0';

        item.appendChild(cb);
        item.appendChild(avatar);
        item.appendChild(document.createTextNode(' ' + fullName));
        popover.appendChild(item);
      });
    });
  }

  // ─── Date Popover ─────────────────────────────────────────────────────────

  function openDatePopover(td, card, onUpdate) {
    openPopover(td, function (popover) {
      popover.style.padding = '12px 14px';
      popover.style.minWidth = '220px';

      var header = document.createElement('div');
      header.className = 'popover-header';
      header.style.cssText = 'margin:-12px -14px 10px;padding:6px 14px 4px;';
      header.textContent = 'Due Date';
      popover.appendChild(header);

      var dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.className = 'cell-input';
      dateInput.style.cssText = 'width:100%;margin-bottom:10px;';
      if (card.due) {
        dateInput.value = card.due.substring(0, 10);
      }
      // Auto-save as soon as user picks a date
      dateInput.addEventListener('change', function () {
        var val = dateInput.value;
        if (!val) return;
        var d = new Date(val + 'T12:00:00');
        apiPut('/cards/' + card.id, { due: d.toISOString() })
          .then(function () {
            card.due = d.toISOString();
            closePopover();
            onUpdate();
          })
          .catch(function (err) { console.error('[GTD] Due date save failed', err); });
      });
      popover.appendChild(dateInput);

      var removeBtn = document.createElement('button');
      removeBtn.className = 'toolbar-btn secondary';
      removeBtn.style.cssText = 'width:100%;margin-top:2px;';
      removeBtn.textContent = 'Remove due date';
      removeBtn.addEventListener('click', function () {
        apiPut('/cards/' + card.id, { due: null })
          .then(function () {
            card.due = null;
            card.dueComplete = false;
            closePopover();
            onUpdate();
          })
          .catch(function (err) { console.error('[GTD] Due date remove failed', err); });
      });
      popover.appendChild(removeBtn);

      dateInput.focus();
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function visibleColumns() {
    return state.columns.filter(function (c) { return c.visible; });
  }

  function showLoading(visible) {
    var overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = visible ? 'flex' : 'none';
  }

  function showError(msg) {
    var tbody = document.getElementById('table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 20;
    td.className = 'error-state';
    td.textContent = msg;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

}());
