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
    { id: 'list',    label: 'List',     visible: true,  sortable: true,  type: 'readonly', minWidth: 140, native: true },
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
    filters:        { search: '', list: '' },
    apiToken:       null
  };

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  t.render(function () {
    showLoading(true);

    return loadPreferences()
      .then(function () {
        return t.getRestApi().isAuthorized();
      })
      .then(function (isAuthorized) {
        if (!isAuthorized) {
          showLoading(false);
          showAuthOverlay();
          return;
        }
        return t.getRestApi().getToken()
          .then(function (token) {
            state.apiToken = token;
            return loadData();
          })
          .then(function () {
            showLoading(false);
            buildUI();
          });
      })
      .catch(function (err) {
        showLoading(false);
        showError('Failed to initialize: ' + (err && err.message ? err.message : String(err)));
      });
  });

  // ─── Auth Overlay ──────────────────────────────────────────────────────────

  function showAuthOverlay() {
    var overlay = document.getElementById('auth-overlay');
    if (overlay) overlay.classList.remove('hidden');

    var authBtn = document.getElementById('auth-btn');
    if (!authBtn) return;

    authBtn.addEventListener('click', function () {
      t.getRestApi().authorize({ scope: { read: true, write: true } })
        .then(function (token) {
          state.apiToken = token;
          hideAuthOverlay();
          showLoading(true);
          return loadData();
        })
        .then(function () {
          showLoading(false);
          buildUI();
        })
        .catch(function (err) {
          showLoading(false);
          showError('Authorization failed: ' + (err && err.message ? err.message : String(err)));
        });
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
          + '&card_fields=id,name,idList,labels,due,dueComplete,idMembers,pos,closed'
          + '&customFields=true'
          + '&lists=open'
          + '&list_fields=id,name,pos'
          + '&members=all'
          + '&member_fields=id,fullName,username'
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
    renderTable();
    buildColumnDropdown();
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
              state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
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
        td.className = 'cell-name';
        var nameLink = document.createElement('a');
        nameLink.className = 'card-name-link';
        nameLink.href = '#';
        nameLink.title = card.name;
        nameLink.textContent = card.name;
        nameLink.addEventListener('click', function (e) {
          e.preventDefault();
          t.showCard(card.id);
        });
        td.appendChild(nameLink);
        break;

      case 'readonly':
        td.className = 'cell-readonly';
        td.title = state.lists[card.idList] || '';
        td.textContent = state.lists[card.idList] || '';
        break;

      case 'labels':
        td.className = 'cell-labels';
        (card.labels || []).forEach(function (lbl) {
          td.appendChild(makeLabelChip(lbl));
        });
        break;

      case 'date':
        td.className = 'cell-date';
        if (card.due) {
          var d = new Date(card.due);
          td.textContent = d.toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric'
          });
          if (card.dueComplete) {
            td.classList.add('due-complete');
          } else if (d < new Date()) {
            td.classList.add('due-overdue');
          }
        } else {
          td.textContent = '';
        }
        break;

      case 'members':
        td.className = 'cell-members';
        (card.idMembers || []).forEach(function (mid) {
          var fullName = state.members[mid];
          if (!fullName) return;
          var initials = fullName.split(' ')
            .map(function (n) { return n[0]; })
            .join('')
            .toUpperCase()
            .slice(0, 2);
          var avatar = document.createElement('span');
          avatar.className = 'member-avatar';
          avatar.textContent = initials;
          avatar.title = fullName;
          td.appendChild(avatar);
        });
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

    td.addEventListener('click', function () {
      if (!td.querySelector('input')) showEditor();
    });

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

    td.addEventListener('click', function () {
      if (!td.querySelector('input')) showEditor();
    });

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

    function showEditor() {
      td.innerHTML = '';
      var select = document.createElement('select');
      select.className = 'cell-select';

      var blankOpt = document.createElement('option');
      blankOpt.value = '';
      blankOpt.textContent = '— None —';
      select.appendChild(blankOpt);

      cf.options.forEach(function (opt) {
        var option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.value.text;
        if (opt.id === currentIdValue) option.selected = true;
        select.appendChild(option);
      });

      td.appendChild(select);
      select.focus();

      function commit() {
        var nextIdValue = select.value;
        if (nextIdValue !== currentIdValue) {
          currentIdValue = nextIdValue;
          var payload = nextIdValue ? { idValue: nextIdValue } : { idValue: '' };
          saveCustomFieldValue(card, cf, payload);
          // Re-render the cell after state update
          renderCell(td, card, { id: 'cf_' + cf.id, type: 'customField', cf: cf });
        } else {
          showDisplay();
        }
      }

      select.addEventListener('change', commit);
      select.addEventListener('blur', function () {
        if (td.querySelector('select')) commit();
      });
      select.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { select.value = currentIdValue; select.blur(); }
        e.stopPropagation();
      });
    }

    td.addEventListener('click', function () {
      if (!td.querySelector('select')) showEditor();
    });

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

    td.addEventListener('click', function () {
      checked = !checked;
      saveCustomFieldValue(card, cf, { value: { checked: checked ? 'true' : 'false' } });
      showDisplay();
    });

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

  // ─── Label Chip ────────────────────────────────────────────────────────────

  function makeLabelChip(label) {
    var chip = document.createElement('span');
    chip.className = 'label-chip';
    var hex = LABEL_HEX[label.color] || LABEL_HEX['null'];
    chip.style.backgroundColor = hex;
    chip.style.color = isLightHex(hex) ? '#1d2125' : '#ffffff';
    chip.textContent = label.name || label.color || '';
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

    if (f.list) {
      cards = cards.filter(function (card) { return card.idList === f.list; });
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

    var listSelect = document.getElementById('list-filter');
    if (listSelect) {
      listSelect.addEventListener('change', function () {
        state.filters.list = this.value;
        renderTableBody();
      });
    }

    var clearBtn = document.getElementById('clear-filters-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state.filters = { search: '', list: '' };
        var si = document.getElementById('search-input');
        if (si) si.value = '';
        var ls = document.getElementById('list-filter');
        if (ls) ls.value = '';
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
