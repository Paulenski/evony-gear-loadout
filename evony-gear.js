/* =========================================
   Evony Gear Selector - script.js
   Backend: Google Apps Script Web App (public)
   Columns:
     Gear: name, slot, setname, tier, attr1..attr4, imageurl
     Set Bonus: Set, Tier, 2/2 Bonus, 4/4 Bonus, 6/6 Bonus
   - Prefers setname (fallback to tier) for grouping and bonuses
   - Clear, compact set-bonus containers (always show 2/2, 4/4, 6/6 lines)
   - Event delegation (no fragile inline JSON)
   - Idempotent initialization
   ========================================= */
(function () {
  if (window.EvonyGearInitialized) {
    console.info('Evony Gear: already initialized; skipping.');
    return;
  }
  window.EvonyGearInitialized = true;

  // CONFIG: Your deployed Apps Script Web App URL (must end with /exec)
  const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbzl_MtXcoQ6bjUbVqnmRDp-sv1DRuea0eG2KrsXHi2qv-o7M0FEoE4mO5nDgZ5Qx5CcSQ/exec';
  const ENDPOINT_TOKEN = ''; // optional: set if you added ACCESS_TOKEN in Apps Script

  // Namespaced shared state
  const S = (window.EvonyGearState = window.EvonyGearState || {});
  S.equippedGear = S.equippedGear || {
    weapon: null, helmet: null, chest: null, legs: null, boots: null, ring: null
  };
  S.allItems = S.allItems || [];
  S.setBonusData = S.setBonusData || {};   // raw object from backend
  S.setBonusIndex = S.setBonusIndex || {}; // normalized index built from raw
  S.currentSlot = S.currentSlot || null;

  const SLOT_LABELS = {
    weapon: 'Weapon', helmet: 'Helmet', chest: 'Chest Armor',
    legs: 'Leg Armor', boots: 'Boots', ring: 'Ring'
  };

const TROOP_TYPES = ['ground', 'ranged', 'mounted', 'siege'];
const BUFF_TYPES = ['attack', 'defense', 'hp'];

// Filter state
const filterState = {
  activeTroop: null,
  activeBuff: null
};

// Check if an item matches the active filters
function itemMatchesFilters(item) {
  if (!filterState.activeTroop) return true; // No filter active
  
  const attrs = getAttributesString(item).toLowerCase();
  
  // Check if item has the selected troop type
  const hasTroop = attrs.includes(filterState.activeTroop);
  
  if (!filterState.activeBuff) {
    // Only troop filter active
    return hasTroop;
  }
  
  // Both filters active: check troop AND buff type
  const hasBuff = attrs.includes(filterState.activeBuff);
  return hasTroop && hasBuff;
}

// Apply filters to visible items
function applyFilters() {
  const modal = document.getElementById('itemModal');
  if (!modal) return;
  
  // Filter tier sections
  document.querySelectorAll('.tier-section').forEach(section => {
    const cards = section.querySelectorAll('.item-card');
    let visibleCount = 0;
    
    cards.forEach(card => {
      const idx = parseInt(card.dataset.itemIdx, 10);
      if (idx === -1) {
        card.style.display = 'block'; // Always show "Remove Item"
        return;
      }
      
      const modalBody = document.getElementById('modalBody');
      const item = modalBody?._itemsCache?.[idx];
      
      if (item && itemMatchesFilters(item)) {
        card.style.display = 'block';
        visibleCount++;
      } else {
        card.style.display = 'none';
      }
    });
    
    // Hide entire section if no visible items
    section.style.display = visibleCount > 0 ? 'block' : 'none';
  });
}

// Toggle troop filter
window.toggleTroopFilter = function(troop) {
  if (filterState.activeTroop === troop) {
    // Turn off
    filterState.activeTroop = null;
    filterState.activeBuff = null; // Reset buff filter too
  } else {
    // Turn on
    filterState.activeTroop = troop;
    filterState.activeBuff = null; // Reset buff filter when switching troops
  }
  
  updateFilterButtons();
  applyFilters();
};

// Toggle buff filter
window.toggleBuffFilter = function(buff) {
  if (!filterState.activeTroop) return; // Can't filter buff without troop
  
  if (filterState.activeBuff === buff) {
    // Turn off
    filterState.activeBuff = null;
  } else {
    // Turn on
    filterState.activeBuff = buff;
  }
  
  updateFilterButtons();
  applyFilters();
};

// ADD THESE AFTER THE FILTER STATE SECTION (after the troop/buff filters):

// Wall General filter state
const wallGeneralFilters = {
  hideAttacking: false,
  showAsWallGeneral: false
};

// Toggle wall general filters
window.toggleWallFilter = function(filterType) {
  if (filterType === 'hideAttacking') {
    wallGeneralFilters.hideAttacking = !wallGeneralFilters.hideAttacking;
  } else if (filterType === 'wallGeneral') {
    wallGeneralFilters.showAsWallGeneral = !wallGeneralFilters.showAsWallGeneral;
  }
  
  // Update checkbox states
  const hideAttackingBox = document.getElementById('filter-hide-attacking');
  const wallGeneralBox = document.getElementById('filter-wall-general');
  
  if (hideAttackingBox) hideAttackingBox.checked = wallGeneralFilters.hideAttacking;
  if (wallGeneralBox) wallGeneralBox.checked = wallGeneralFilters.showAsWallGeneral;
  
  // Recalculate and update display
  updateStatsDisplay();
};

// Check if a buff name indicates it's an "attacking" conditional
function isAttackingBuff(name) {
  const norm = normStatKey(name);
  return /^attacking\b/.test(norm);
}

// Check if a buff is "in-city"
function isInCityBuff(name) {
  const norm = normStatKey(name);
  return /^in[-\s]?city\b/.test(norm);
}

// Determine if a line should be included based on wall general filters
function shouldIncludeLine(line, domain) {
  // If "Hide Attacking Buffs" is checked, exclude attacking buffs
  if (wallGeneralFilters.hideAttacking && isAttackingBuff(line.name)) {
    return false;
  }
  
  // If "Show as Wall General" is NOT checked, normal behavior
  if (!wallGeneralFilters.showAsWallGeneral) {
    return true;
  }
  
  // Wall General mode: show field buffs (standard) + in-city buffs together
  // This means we want to include:
  // - All field domain buffs (they become base buffs)
  // - All inCity domain buffs (they stack with field)
  // - But NOT attacking buffs (already filtered above if hideAttacking is true)
  
  return true; // Include by default in wall general mode
}


// Update button states
function updateFilterButtons() {
  // Troop buttons
  TROOP_TYPES.forEach(troop => {
    const btn = document.getElementById(`filter-troop-${troop}`);
    if (btn) {
      if (filterState.activeTroop === troop) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });
  
  // Buff buttons
  const buffRow = document.getElementById('buffFilterRow');
  if (buffRow) {
    buffRow.style.display = filterState.activeTroop ? 'flex' : 'none';
  }
  
  BUFF_TYPES.forEach(buff => {
    const btn = document.getElementById(`filter-buff-${buff}`);
    if (btn) {
      if (filterState.activeBuff === buff) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });
}

// ADD THESE HERE ↓
  // Preferred set display order
  const SET_ORDER = ['dragon', 'ares', 'ach', 'imperial', 'parthian', 'asura', 'apollo'];

  // Aliases to detect sets by name (normalized, lowercased, non-alphanumerics removed)
  const SET_ALIASES = {
    dragon:    ['dragon'],
    ares:      ['ares'],
    ach:       ['achaemenidae','achaemenid','achae','ach'],
    imperial:  ['imperial'],
    parthian:  ['parthian'],
    asura:     ['asura'],
    apollo:    ['apollo']
  };

  function setOrderKey(str) {
    const n = (str || '').toString().trim().toLowerCase();
    const norm = n.replace(/[^a-z0-9]/g, '');
    for (const [key, needles] of Object.entries(SET_ALIASES)) {
      if (needles.some(term => norm.includes(term))) return key;
    }
    return null;
  }

  function setOrderIndex(str) {
    const key = setOrderKey(str);
    if (!key) return 999;
    const idx = SET_ORDER.indexOf(key);
    return idx === -1 ? 999 : idx;
  }
  // END OF SET-ORDER CODE ↑


  // Normalizers
  function normalizeSlot(s) {
    const x = (s || '').toString().trim().toLowerCase();
    switch (x) {
      case 'weapon': return 'weapon';
      case 'helmet': return 'helmet';
      case 'chest':
      case 'chest armor':
      case 'chest armour': return 'chest';
      case 'leg':
      case 'legs':
      case 'leg armor':
      case 'leg armour': return 'legs';
      case 'boots': return 'boots';
      case 'ring': return 'ring';
      default: return x;
    }
  }
  function normalizeKey(s) {
    return (s || '').toString().trim().toLowerCase();
  }
  function getItemSetName(item) {
    // Prefer setname, fallback to set (if backend provides it)
    return (item?.setname || item?.set || '').toString().trim();
  }

  // UI helper
  function showError(message) {
    const container = document.querySelector('.container');
    if (!container) return;
    const div = document.createElement('div');
    div.style.cssText =
      'background:#7a1f1f;padding:12px;border-radius:6px;margin-bottom:12px;text-align:center;';
    div.innerHTML = `<strong>⚠️ Error:</strong> ${message}`;
    container.insertBefore(div, container.firstChild);
  }

  // Attribute handling
  function getAttributesString(item) {
    const parts = [];
    ['attr1', 'attr2', 'attr3', 'attr4'].forEach((k) => {
      const v = (item?.[k] || '').trim();
      if (v) parts.push(v);
    });
    if (parts.length === 0 && item?.attributes) return item.attributes.trim();
    return parts.join(', ');
  }

  // Parse a string like "Name: +12.5%", "Name +12.5%", "Name %: +12.5", "Name:+1,500"
function parseAndAddStats(attributeString, statsObject) {
  if (!attributeString) return;

  attributeString
    .split(/[,;]+/)              // comma or semicolon separated
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(tok => {
      // Allow optional colon, allow 1,234 style, capture optional %
      // 1: stat name (greedy but minimal via +?), 2: signed number with commas, 3: % if present
      const m = tok.match(/^(.+?)(?::)?\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(%?)$/i);
      if (!m) return;

      let name = m[1].trim();
      let numStr = m[2].replace(/,/g, '');  // drop thousands separators
      const hadPercentInValue = m[3] === '%';
      const nameAlreadyHasPercent = /%/.test(name);

      const value = parseFloat(numStr);
      if (isNaN(value)) return;

      // If the value had a % but the name doesn't, append a % marker to stat name
      if (hadPercentInValue && !nameAlreadyHasPercent) {
        name = `${name} %`;
      }

      // Canonicalize "Name  %" -> "Name %"
      name = name.replace(/\s+%$/, ' %');

      statsObject[name] = (statsObject[name] || 0) + value;
    });
}

  // Fetch from Apps Script
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  // Build normalized index from raw bonuses: keys may be set names or tiers
  function buildBonusIndex(rawBonuses) {
    const idx = {};
    Object.keys(rawBonuses || {}).forEach((displayKey) => {
      const norm = normalizeKey(displayKey);
      const pieces = rawBonuses[displayKey] || {};
      idx[norm] = {
        displayKey,
        pieces: {
          2: pieces[2] || '',
          4: pieces[4] || '',
          6: pieces[6] || ''
        }
      };
    });
    return idx;
  }

  async function loadAllData() {
    try {
      const qs = new URLSearchParams({ action: 'all' });
      if (ENDPOINT_TOKEN) qs.set('key', ENDPOINT_TOKEN);
      const data = await fetchJSON(`${ENDPOINT_URL}?${qs.toString()}`);

      if (data.error) {
        showError(data.message || 'Backend error.');
        return;
      }

      // Items: normalize slot; keep setname, tier, attr1..attr4, imageurl
      S.allItems = (data.items || []).map((i) => ({
        ...i,
        slot: normalizeSlot(i.slot)
      }));

      // Bonuses: index by normalized key (set or tier name)
      S.setBonusData = data.bonuses || {};
      S.setBonusIndex = buildBonusIndex(S.setBonusData);

      console.log('EvonyGear: loaded items:', S.allItems.length);
      console.log('EvonyGear: loaded bonus keys:', Object.keys(S.setBonusData));
    } catch (e) {
      console.error(e);
      showError('Failed to load data from Apps Script. Check Web App URL and access.');
    }
  }

  // Choose the bonus key for a piece: prefer setname, else tier
  function getBonusKeyForItem(item) {
    const setName = getItemSetName(item);
    return setName || item?.tier || '';
  }

function setOrderIndex(str) {
  const key = setOrderKey(str);
  if (!key) return 999; // unknown sets go to the end
  const idx = SET_ORDER.indexOf(key);
  return idx === -1 ? 999 : idx;
}
// Safely escape any text we inject into HTML
function esc(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

// Return up to 4 attribute lines from attr1..attr4; fallback to splitting a single "attributes" string
function getAttributesArray(item) {
  const parts = [];
  ['attr1', 'attr2', 'attr3', 'attr4'].forEach((k) => {
    const v = (item?.[k] || '').trim();
    if (v) parts.push(v);
  });
  if (!parts.length && item?.attributes) {
    // split a combined attributes cell into tokens
    const tokens = item.attributes.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    parts.push(...tokens);
  }
  return parts.slice(0, 4);
}

window.openGearModal = function openGearModal(slot) {
  S.currentSlot = slot;
  
  // Reset filters when opening modal
  filterState.activeTroop = null;
  filterState.activeBuff = null;
  
  const modal = document.getElementById('itemModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');

  if (!modal || !modalTitle || !modalBody) {
    showError('Modal elements not found in HTML.');
    return;
  }

  modalTitle.textContent = `Select ${SLOT_LABELS[slot] || slot}`;

  // Items for this slot
  const slotItems = S.allItems.filter((item) => (item.slot || '').toLowerCase() === slot);

  // Prefer grouping by setname if any item has it; else group by tier
  const itemsHaveSet = slotItems.some((it) => getItemSetName(it).length > 0);
  const groupGetter = (it) => (itemsHaveSet ? (getItemSetName(it) || 'Unknown Set') : (it.tier || 'Unknown Tier'));

  // Build groups
  const groups = {};
  slotItems.forEach((item) => {
    const key = groupGetter(item);
    (groups[key] ||= []).push(item);
  });

  // Filter buttons HTML
  const troopFilterHtml = `
    <div class="filter-section">
      <div class="filter-label">Filter by Troop Type:</div>
      <div class="filter-buttons" id="troopFilterRow">
        ${TROOP_TYPES.map(troop => `
          <button 
            class="filter-btn" 
            id="filter-troop-${troop}"
            onclick="toggleTroopFilter('${troop}')"
          >
            ${troop.charAt(0).toUpperCase() + troop.slice(1)}
          </button>
        `).join('')}
      </div>
    </div>
    <div class="filter-section" id="buffFilterRow" style="display:none;">
      <div class="filter-label">Filter by Buff Type:</div>
      <div class="filter-buttons">
        ${BUFF_TYPES.map(buff => `
          <button 
            class="filter-btn" 
            id="filter-buff-${buff}"
            onclick="toggleBuffFilter('${buff}')"
          >
            ${buff.charAt(0).toUpperCase() + buff.slice(1)}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  let html = `
    <div class="search-container">
      <input type="text" id="itemSearch" class="search-input" placeholder="🔍 Search items..." onkeyup="filterItems()">
    </div>
    ${troopFilterHtml}
    <div class="item-card" data-item-idx="-1">
      <div class="item-name">❌ Remove Item</div>
      <div class="item-attributes">Clear this slot</div>
    </div>
    <div class="tier-divider"></div>
  `;

  // Sort groups
  const groupNames = Object.keys(groups).sort((a, b) => {
    if (itemsHaveSet) {
      const ia = setOrderIndex(a);
      const ib = setOrderIndex(b);
      if (ia !== ib) return ia - ib;
      return a.localeCompare(b);
    } else {
      const na = parseInt((a.match(/\d+/) || [0])[0], 10);
      const nb = parseInt((b.match(/\d+/) || [0])[0], 10);
      if ((/tier/i.test(a) || /tier/i.test(b)) && (na || nb)) return nb - na;
      return a.localeCompare(b);
    }
  });

  const itemsFlat = [];

  groupNames.forEach((name) => {
  const items = groups[name];
  const hasSelectedInGroup = items.some((it) => S.equippedGear[slot]?.name === it.name);

  // Count only items that match the current filters
  const filteredCount = items.filter(item => itemMatchesFilters(item)).length;
  const countLabel = `$${filteredCount}$$ {filteredCount === 1 ? 'item' : 'items'}`;

  html += `
    <div class="tier-section ${hasSelectedInGroup ? 'selected' : ''}">
      <div class="tier-header">
        <div class="tier-title">${name}</div>
        <span class="tier-count">${countLabel}</span>
      </div>
      <div class="tier-items">
  `;

    items.forEach((item) => {
      const idx = itemsFlat.length;
      itemsFlat.push(item);
      const isSelected = S.equippedGear[slot]?.name === item.name;

      const attrs = getAttributesArray(item);
      const listHtml = attrs.length
        ? `<ul class="attr-list">${attrs.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
        : `<ul class="attr-list"><li>No attributes</li></ul>`;

      const hiddenAttrText = esc(getAttributesString(item) || '');

      html += `
        <div class="item-card ${isSelected ? 'selected' : ''}" data-item-idx="${idx}">
          <div class="item-name" style="color:#ffd700;font-weight:800;">${esc(item.name)}</div>
          ${listHtml}
          <div class="item-attributes" style="display:none;">${hiddenAttrText}</div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
      <div class="tier-divider"></div>
    `;
  });

  if (!groupNames.length) {
    html = '<p style="text-align:center;color:#888;">No items available for this slot</p>';
  }

  modalBody.innerHTML = html;
  modalBody._itemsCache = itemsFlat;

  modalBody.onclick = function (e) {
    const card = e.target.closest('.item-card');
    if (!card) return;
    const idx = parseInt(card.dataset.itemIdx, 10);
    if (idx === -1 || isNaN(idx)) {
      window.selectItem && window.selectItem(null);
    } else {
      window.selectItem && window.selectItem(modalBody._itemsCache[idx]);
    }
  };

  modal.style.display = 'block';
  updateFilterButtons();
};

  window.closeModal =
    window.closeModal ||
    function closeModal() {
      const modal = document.getElementById('itemModal');
      if (modal) modal.style.display = 'none';
    };

window.filterItems = function filterItems() {
  const q = (document.getElementById('itemSearch')?.value || '').toLowerCase();
  document.querySelectorAll('#itemModal .item-card').forEach((card) => {
    const name = card.querySelector('.item-name')?.textContent.toLowerCase() || '';
    const attrHidden = card.querySelector('.item-attributes')?.textContent.toLowerCase() || '';
    const attrListText = card.querySelector('.attr-list')?.textContent.toLowerCase() || '';
    const isRemove = card.dataset.itemIdx === '-1';
    
    // Check search match
    const searchMatches = (
      isRemove ||
      name.includes(q) ||
      attrHidden.includes(q) ||
      attrListText.includes(q)
    );
    
    // Check filter match
    const idx = parseInt(card.dataset.itemIdx, 10);
    const modalBody = document.getElementById('modalBody');
    const item = (idx >= 0 && modalBody?._itemsCache) ? modalBody._itemsCache[idx] : null;
    const filterMatches = !item || itemMatchesFilters(item);
    
    card.style.display = (searchMatches && filterMatches) ? 'block' : 'none';
  });
  
  // Update section visibility
  document.querySelectorAll('.tier-section').forEach(section => {
    const visibleCards = Array.from(section.querySelectorAll('.item-card'))
      .filter(card => card.style.display !== 'none');
    section.style.display = visibleCards.length > 0 ? 'block' : 'none';
  });
};

  window.selectItem =
    window.selectItem ||
    function selectItem(item) {
      S.equippedGear[S.currentSlot] = item;
      updateGearDisplay();
      updateStatsDisplay();
      updateSetBonuses();
      saveToLocalStorage();
      window.closeModal();
    };

  window.clearAll =
    window.clearAll ||
    function clearAll() {
      if (!confirm('Clear all equipped items?')) return;
      Object.keys(S.equippedGear).forEach((k) => (S.equippedGear[k] = null));
      updateGearDisplay();
      updateStatsDisplay();
      updateSetBonuses();
      saveToLocalStorage();
    };

  // Internal UI updaters
function updateGearDisplay() {
  Object.keys(S.equippedGear).forEach((slot) => {
    const slotEl = document.querySelector(`.gear-slot[data-slot="${slot}"]`);
    if (!slotEl) return;
    const contentEl = slotEl.querySelector('.gear-slot-content');
    const item = S.equippedGear[slot];

    // NEW: caption under the box
    const captionEl = document.querySelector(`.slot-caption[data-slot-caption="${slot}"]`);

    if (item) {
      slotEl.classList.add('equipped');
      slotEl.title = item.name || SLOT_LABELS[slot] || slot;
      contentEl.innerHTML = `
        <div class="badge-tier">${getItemSetName(item) || item.tier || ''}</div>
        <div class="checkmark">✓</div>
      `;
      if (captionEl) captionEl.textContent = item.name || (SLOT_LABELS[slot] || slot);
    } else {
      slotEl.classList.remove('equipped');
      slotEl.title = SLOT_LABELS[slot] || slot;
      contentEl.innerHTML = '';
      if (captionEl) captionEl.textContent = (SLOT_LABELS[slot] || slot);
    }
  });
}

// Helpers to classify stats
function getStatTokens(attributeString) {
  if (!attributeString) return [];
  return attributeString
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(tok => {
      const m = tok.match(/^(.+?)(?::)?\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(%?)$/i);
      if (!m) return null;
      const rawName = m[1].trim();
      const isPercent = m[3] === '%';
      const value = parseFloat((m[2] || '').replace(/,/g, ''));
      if (isNaN(value)) return null;
      return { rawName, value, isPercent };
    })
    .filter(Boolean);
}

// Normalize a stat key for matching (lowercase, single spaces, remove trailing " %")
function normStatKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+%$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Determine domain/troop/attacking/substat classification
function classifyStat(rawName) {
  let s = normStatKey(rawName); // e.g., "in city attacking ground attack"
  let domain = 'field'; // 'field' | 'inCity' | 'march' | 'other'
  let attacking = false;
  let troop = null;     // 'ground' | 'ranged' | 'mounted' | 'siege' | null
  let substat = 'other';// 'attack' | 'hp' | 'defense' | 'other'
// ADD THIS NEW HELPER after the classifyStat function:

// Check if a stat is a conditional "Attacking" all-troop bonus
function isAttackingAllTroopBonus(rawName) {
  const norm = normStatKey(rawName);
  // Match patterns like "attacking troop's attack", "attacking troop attack", etc.
  return /^attacking\s+troop'?s?\s+attack\b/.test(norm) || 
         /^attacking\s+troops?\s+attack\b/.test(norm);
}

// Check if a stat is a conditional "Attacking" all-troop defense
function isAttackingAllTroopDefense(rawName) {
  const norm = normStatKey(rawName);
  return /^attacking\s+troop'?s?\s+def(ense)?\b/.test(norm) || 
         /^attacking\s+troops?\s+def(ense)?\b/.test(norm);
}

// Check if a stat is a conditional "Attacking" all-troop HP
function isAttackingAllTroopHP(rawName) {
  const norm = normStatKey(rawName);
  return /^attacking\s+troop'?s?\s+hp\b/.test(norm) || 
         /^attacking\s+troops?\s+hp\b/.test(norm);
}

  // March
  if (/^march size\b/.test(s) || /^march capacity\b/.test(s)) {
    return { domain: 'march', attacking, troop, substat, label: rawName };
  }
  if (/^march speed\b/.test(s)) {
    return { domain: 'march', attacking, troop, substat, label: rawName };
  }

  // In-City
  if (/^in[-\s]?city\b/.test(s)) {
    domain = 'inCity';
    s = s.replace(/^in[-\s]?city\s+/, '');
  }

  // Attacking
  if (/^attacking\b/.test(s)) {
    attacking = true;
    s = s.replace(/^attacking\s+/, '');
  }

  // Troop detection
  const troopMatch = s.match(/^(ground|ranged|mounted|siege)\b/);
  if (troopMatch) {
    troop = troopMatch[1];
    s = s.replace(/^(ground|ranged|mounted|siege)\s+/, '');
  }

  // Substat detection
  if (/\battack\b/.test(s)) substat = 'attack';
  else if (/\bhp\b/.test(s)) substat = 'hp';
  else if (/\bdef(ense)?\b/.test(s)) substat = 'defense';
  else substat = 'other';

  // All Troop special (applies to all troop types)
  const isAllTroop = /^all\s+troop(s)?\b/.test(normStatKey(rawName));

  return { domain, attacking, troop, substat, isAllTroop, label: rawName };
}

// ADD THESE HELPER FUNCTIONS (place them after the classifyStat function):

// Check if a stat is a conditional "Attacking" all-troop bonus
function isAttackingAllTroopBonus(rawName) {
  const norm = normStatKey(rawName);
  // Match patterns like "attacking troop's attack", "attacking troop attack", etc.
  return /^attacking\s+troop'?s?\s+attack\b/.test(norm) || 
         /^attacking\s+troops?\s+attack\b/.test(norm);
}

// Check if a stat is a conditional "Attacking" all-troop defense
function isAttackingAllTroopDefense(rawName) {
  const norm = normStatKey(rawName);
  return /^attacking\s+troop'?s?\s+def(ense)?\b/.test(norm) || 
         /^attacking\s+troops?\s+def(ense)?\b/.test(norm);
}

// Check if a stat is a conditional "Attacking" all-troop HP
function isAttackingAllTroopHP(rawName) {
  const norm = normStatKey(rawName);
  return /^attacking\s+troop'?s?\s+hp\b/.test(norm) || 
         /^attacking\s+troops?\s+hp\b/.test(norm);
}

// Structure for grouped totals
function makeTotalsStruct() {
  const emptyTroop = () => ({ lines: [], sum: { attack: 0, hp: 0, defense: 0, totalPct: 0 } });
  return {
    field:   { ground: emptyTroop(), ranged: emptyTroop(), mounted: emptyTroop(), siege: emptyTroop() },
    inCity:  { ground: emptyTroop(), ranged: emptyTroop(), mounted: emptyTroop(), siege: emptyTroop() },
    march:   { lines: [] },
    other:   { lines: [] }
  };
}

// Add a line into totals
// replicated=true is only passed when we intentionally duplicate (e.g., All Troop)
function addLine(totals, domain, troop, substat, displayName, value, isPercent, source, replicated = false) {
  if (domain === 'field' || domain === 'inCity') {
    if (!troop) {
      // No troop specified: do NOT auto-replicate; treat as "other" within this domain
      // This respects your rule: only place into troop categories when explicitly matched,
      // otherwise it will be visible in "Other" section (or March).
      totals.other.lines.push({ name: displayName, value, isPercent, source });
      return;
    }
    const bucket = totals[domain][troop];
    const line = { name: displayName, value, isPercent, source, substat, replicated };
    bucket.lines.push(line);
    if (isPercent) {
      if (substat === 'attack')  bucket.sum.attack  += value;
      if (substat === 'hp')      bucket.sum.hp      += value;
      if (substat === 'defense') bucket.sum.defense += value;
      bucket.sum.totalPct += value;
    }
    return;
  }

  if (domain === 'march') {
    totals.march.lines.push({ name: displayName, value, isPercent, source });
    return;
  }

  // Other catch-all
  totals.other.lines.push({ name: displayName, value, isPercent, source });
}

// Render a troop card with Attack/Defense/HP breakdown
// Render a troop card with Attack/Defense/HP breakdown
// Render a troop card with Attack/Defense/HP breakdown (respecting filters)
function renderTroopCard(title, bucket, groupKey) {
  if (!bucket.lines.length) return '';
  
  // Apply filters to lines
  const domain = groupKey.includes('inCity') ? 'inCity' : 'field';
  const filteredLines = bucket.lines.filter(l => shouldIncludeLine(l, domain));
  
  if (!filteredLines.length) return '';
  
  // Group lines by substat
  const attackLines = filteredLines.filter(l => l.substat === 'attack');
  const defenseLines = filteredLines.filter(l => l.substat === 'defense');
  const hpLines = filteredLines.filter(l => l.substat === 'hp');
  const otherLines = filteredLines.filter(l => l.substat === 'other');
  
  // Recalculate totals based on filtered lines
  const attackTotal = attackLines.reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
  const defenseTotal = defenseLines.reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
  const hpTotal = hpLines.reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
  const grandTotal = attackTotal + defenseTotal + hpTotal;
  
  // Render a substat column with full names
  const renderSubstatCol = (subLines, subName, subTotal) => {
    if (!subLines.length) return '';
    return `
      <div class="substat-col">
        <div class="substat-header">${subName}</div>
        <div class="substat-lines">
          ${subLines.map(l => `
            <div class="substat-line ${l.source === 'set' ? 'set' : ''}">
              <div class="substat-name">${esc(l.name)}</div>
              <div class="substat-value">${l.isPercent ? `+${l.value.toFixed(1)}%` : `+${l.value.toLocaleString()}`}</div>
            </div>
          `).join('')}
        </div>
        <div class="substat-total">
          <span class="total-label">Total:</span>
          <span class="total-value">+${subTotal.toFixed(1)}%</span>
        </div>
      </div>
    `;
  };
  
  const attackHtml = renderSubstatCol(attackLines, 'Attack', attackTotal);
  const defenseHtml = renderSubstatCol(defenseLines, 'Defense', defenseTotal);
  const hpHtml = renderSubstatCol(hpLines, 'HP', hpTotal);
  
  // Show "other" lines separately if any exist
  const otherHtml = otherLines.length ? `
    <div class="other-stats">
      <div class="other-stats-header">Other Buffs</div>
      ${otherLines.map(l => `
        <div class="totals-line ${l.source === 'set' ? 'set' : ''}">
          <div class="name">${esc(l.name)}</div>
          <div class="value">${l.isPercent ? `+${l.value.toLocaleString()}%` : `+${l.value.toLocaleString()}`}</div>
        </div>
      `).join('')}
    </div>
  ` : '';
  
  return `
    <div class="totals-card" data-group="${groupKey}">
      <div class="totals-title">
        <span>${title}</span>
        <span class="grand-total">+${grandTotal.toFixed(1)}%</span>
      </div>
      <div class="substat-grid">
        ${attackHtml}
        ${defenseHtml}
        ${hpHtml}
      </div>
      ${otherHtml}
    </div>
  `;
}

// Calculate condensed header: G/R/M/S with A/D/H breakdown
// Generate a clean table of totals for the header
// Generate a clean table of totals for the header with filter checkboxes
function condensedHeaderTable(totals) {
  const troops = [
    { name: 'Ground', key: 'ground' },
    { name: 'Ranged', key: 'ranged' },
    { name: 'Mounted', key: 'mounted' },
    { name: 'Siege', key: 'siege' }
  ];

  let html = `
    <div class="wall-filters">
      <label class="wall-filter-checkbox">
        <input 
          type="checkbox" 
          id="filter-hide-attacking"
          ${wallGeneralFilters.hideAttacking ? 'checked' : ''}
          onchange="toggleWallFilter('hideAttacking')"
        />
        <span>Hide Attacking Buffs</span>
        
      </label>
      
      <label class="wall-filter-checkbox">
        <input 
          type="checkbox" 
          id="filter-wall-general"
          ${wallGeneralFilters.showAsWallGeneral ? 'checked' : ''}
          onchange="toggleWallFilter('wallGeneral')"
        />
        <span>Show as Wall General</span>
       
      </label>
    </div>
    
    <table class="totals-header-table">
      <thead>
        <tr>
          <th>Troop</th>
          <th>Attack</th>
          <th>Defense</th>
          <th>HP</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
  `;

  // Determine which totals to show based on wall general mode
  const displaySource = wallGeneralFilters.showAsWallGeneral ? 'combined' : 'field';

  troops.forEach(troop => {
    let attack = 0, defense = 0, hp = 0, total = 0;

    if (wallGeneralFilters.showAsWallGeneral) {
      // Wall General: combine field + inCity
      const fieldBucket = totals.field[troop.key];
      const inCityBucket = totals.inCity[troop.key];
      
      // Filter out attacking buffs if needed, then sum
      const fieldAttack = fieldBucket.lines
        .filter(l => l.substat === 'attack' && shouldIncludeLine(l, 'field'))
        .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
      const inCityAttack = inCityBucket.lines
        .filter(l => l.substat === 'attack' && shouldIncludeLine(l, 'inCity'))
        .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
      
      const fieldDefense = fieldBucket.lines
        .filter(l => l.substat === 'defense' && shouldIncludeLine(l, 'field'))
        .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
      const inCityDefense = inCityBucket.lines
        .filter(l => l.substat === 'defense' && shouldIncludeLine(l, 'inCity'))
        .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
      
      const fieldHP = fieldBucket.lines
        .filter(l => l.substat === 'hp' && shouldIncludeLine(l, 'field'))
        .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
      const inCityHP = inCityBucket.lines
        .filter(l => l.substat === 'hp' && shouldIncludeLine(l, 'inCity'))
        .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
      
      attack = fieldAttack + inCityAttack;
      defense = fieldDefense + inCityDefense;
      hp = fieldHP + inCityHP;
      total = attack + defense + hp;
    } else {
      // Normal mode: just field
      const bucket = totals.field[troop.key];
      
      if (wallGeneralFilters.hideAttacking) {
        // Recalculate without attacking buffs
        attack = bucket.lines
          .filter(l => l.substat === 'attack' && shouldIncludeLine(l, 'field'))
          .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
        defense = bucket.lines
          .filter(l => l.substat === 'defense' && shouldIncludeLine(l, 'field'))
          .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
        hp = bucket.lines
          .filter(l => l.substat === 'hp' && shouldIncludeLine(l, 'field'))
          .reduce((sum, l) => sum + (l.isPercent ? l.value : 0), 0);
        total = attack + defense + hp;
      } else {
        // Use pre-calculated sums
        attack = bucket.sum.attack;
        defense = bucket.sum.defense;
        hp = bucket.sum.hp;
        total = bucket.sum.totalPct;
      }
    }

    html += `
      <tr>
        <td class="troop-name">${troop.name}</td>
        <td class="stat-value attack">+${Math.round(attack)}%</td>
        <td class="stat-value defense">+${Math.round(defense)}%</td>
        <td class="stat-value hp">+${Math.round(hp)}%</td>
        <td class="stat-value total">+${Math.round(total)}%</td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  return html;
}

function updateStatsDisplay() {
  const totals = makeTotalsStruct();

  // 1) Gear stats
  Object.values(S.equippedGear).forEach(item => {
    if (!item) return;
    const tokens = getStatTokens(getAttributesString(item));
    tokens.forEach(tok => {
      const cls = classifyStat(tok.rawName);
      
      // Check for "Attacking Troop's X" bonuses
      if (isAttackingAllTroopBonus(tok.rawName)) {
        // Add to all troops in field, attack substat
        ['ground','ranged','mounted','siege'].forEach(t => {
          addLine(totals, 'field', t, 'attack', tok.rawName, tok.value, tok.isPercent, 'gear', true);
        });
        return;
      }
      if (isAttackingAllTroopDefense(tok.rawName)) {
        ['ground','ranged','mounted','siege'].forEach(t => {
          addLine(totals, 'field', t, 'defense', tok.rawName, tok.value, tok.isPercent, 'gear', true);
        });
        return;
      }
      if (isAttackingAllTroopHP(tok.rawName)) {
        ['ground','ranged','mounted','siege'].forEach(t => {
          addLine(totals, 'field', t, 'hp', tok.rawName, tok.value, tok.isPercent, 'gear', true);
        });
        return;
      }
      
      // Regular "All Troop" handling
      if (cls.isAllTroop) {
        ['ground','ranged','mounted','siege'].forEach(t => {
          addLine(totals, cls.domain, t, cls.substat, tok.rawName, tok.value, tok.isPercent, 'gear', true);
        });
      } else if (cls.domain === 'field' || cls.domain === 'inCity') {
        addLine(totals, cls.domain, cls.troop, cls.substat, tok.rawName, tok.value, tok.isPercent, 'gear');
      } else {
        addLine(totals, cls.domain, null, cls.substat, tok.rawName, tok.value, tok.isPercent, 'gear');
      }
    });
  });

  // Calculate set bonus counts
  const counts = {};
  Object.values(S.equippedGear).forEach(item => {
    if (!item) return;
    const key = normalizeKey(getBonusKeyForItem(item));
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  });

  // 2) Active set bonuses
  Object.entries(counts).forEach(([normKey, count]) => {
    const entry = S.setBonusIndex[normKey];
    if (!entry) return;
    [2,4,6].forEach(pc => {
      const text = entry.pieces?.[pc] || '';
      if (count >= pc && text) {
        const tokens = getStatTokens(text);
        tokens.forEach(tok => {
          const cls = classifyStat(tok.rawName);
          const nameWithTag = tok.rawName;

          // Check for "Attacking Troop's X" bonuses in set bonuses
          if (isAttackingAllTroopBonus(tok.rawName)) {
            ['ground','ranged','mounted','siege'].forEach(t => {
              addLine(totals, 'field', t, 'attack', nameWithTag, tok.value, tok.isPercent, 'set', true);
            });
            return;
          }
          if (isAttackingAllTroopDefense(tok.rawName)) {
            ['ground','ranged','mounted','siege'].forEach(t => {
              addLine(totals, 'field', t, 'defense', nameWithTag, tok.value, tok.isPercent, 'set', true);
            });
            return;
          }
          if (isAttackingAllTroopHP(tok.rawName)) {
            ['ground','ranged','mounted','siege'].forEach(t => {
              addLine(totals, 'field', t, 'hp', nameWithTag, tok.value, tok.isPercent, 'set', true);
            });
            return;
          }

          // Regular "All Troop" handling
          if (cls.isAllTroop) {
            ['ground','ranged','mounted','siege'].forEach(t => {
              addLine(totals, cls.domain, t, cls.substat, nameWithTag, tok.value, tok.isPercent, 'set', true);
            });
          } else if (cls.domain === 'field' || cls.domain === 'inCity') {
            if (cls.troop) {
              addLine(totals, cls.domain, cls.troop, cls.substat, nameWithTag, tok.value, tok.isPercent, 'set');
            } else {
              addLine(totals, 'other', null, cls.substat, nameWithTag, tok.value, tok.isPercent, 'set');
            }
          } else {
            addLine(totals, cls.domain, null, cls.substat, nameWithTag, tok.value, tok.isPercent, 'set');
          }
        });
      }
    });
  });

  // 3) Render
  // 3) Render
  const statsDisplay = document.getElementById('statsDisplay');
  if (!statsDisplay) return;

  // If completely empty
  const hasAny =
    totals.field.ground.lines.length  || totals.field.ranged.lines.length ||
    totals.field.mounted.lines.length || totals.field.siege.lines.length  ||
    totals.inCity.ground.lines.length || totals.inCity.ranged.lines.length ||
    totals.inCity.mounted.lines.length|| totals.inCity.siege.lines.length ||
    totals.march.lines.length || totals.other.lines.length;

  if (!hasAny) {
    statsDisplay.innerHTML = '<p style="text-align:center;color:#888;">Equip items to see stats</p>';
    const headerCond = document.getElementById('totalsCondensed');
    if (headerCond) headerCond.innerHTML = '';
    return;
  }

  // Check if we have in-city buffs
  const inCityAny = (
    totals.inCity.ground.lines.length  ||
    totals.inCity.ranged.lines.length  ||
    totals.inCity.mounted.lines.length ||
    totals.inCity.siege.lines.length
  );

  // If Wall General mode is active, merge in-city into field
  if (wallGeneralFilters.showAsWallGeneral && inCityAny) {
    ['ground', 'ranged', 'mounted', 'siege'].forEach(troopKey => {
      totals.field[troopKey].lines.push(...totals.inCity[troopKey].lines);
    });
  }

  // Field section
  const fieldHtml = `
    <div class="totals-section">
      <h3>${wallGeneralFilters.showAsWallGeneral ? 'Wall General Buffs (Field + In-City Combined)' : 'Field Buffs'}</h3>
      <div class="totals-grid">
        ${renderTroopCard('Ground',  totals.field.ground,  'field-ground')}
        ${renderTroopCard('Ranged',  totals.field.ranged,  'field-ranged')}
        ${renderTroopCard('Mounted', totals.field.mounted, 'field-mounted')}
        ${renderTroopCard('Siege',   totals.field.siege,   'field-siege')}
      </div>
    </div>
  `;

  // In-City section (only show if NOT in wall general mode)
  const inCityHtml = (inCityAny && !wallGeneralFilters.showAsWallGeneral) ? `
    <div class="totals-section">
      <h3>In-City Buffs</h3>
      <div class="totals-grid">
        ${renderTroopCard('Ground',  totals.inCity.ground,  'inCity-ground')}
        ${renderTroopCard('Ranged',  totals.inCity.ranged,  'inCity-ranged')}
        ${renderTroopCard('Mounted', totals.inCity.mounted, 'inCity-mounted')}
        ${renderTroopCard('Siege',   totals.inCity.siege,   'inCity-siege')}
      </div>
    </div>
  ` : '';

  // March section
  const marchHtml = totals.march.lines.length ? `
    <div class="totals-section">
      <h3>March</h3>
      <div class="totals-grid">
        <div class="totals-card">
          <div class="totals-title"><span>March Buffs</span></div>
          <div class="totals-lines">
            ${totals.march.lines.map(l => `
              <div class="totals-line ${l.source === 'set' ? 'set' : ''}">
                <div class="name">${esc(l.name)}</div>
                <div class="value">${l.isPercent ? `+${l.value.toLocaleString()}%` : `+${l.value.toLocaleString()}`}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  ` : '';

  // Other section
  const otherHtml = totals.other.lines.length ? `
    <div class="totals-section">
      <h3>Other</h3>
      <div class="totals-grid">
        <div class="totals-card">
          <div class="totals-title"><span>Other Buffs</span></div>
          <div class="totals-lines">
            ${totals.other.lines.map(l => `
              <div class="totals-line ${l.source === 'set' ? 'set' : ''}">
                <div class="name">${esc(l.name)}</div>
                <div class="value">${l.isPercent ? `+${l.value.toLocaleString()}%` : `+${l.value.toLocaleString()}`}</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  ` : '';

  statsDisplay.innerHTML = fieldHtml + inCityHtml + marchHtml + otherHtml;

  // Condensed header table
  const headerCond = document.getElementById('totalsCondensed');
  if (headerCond) headerCond.innerHTML = condensedHeaderTable(totals);
}

// New compact set-bonus containers
function updateSetBonuses() {
  const counts = {};
  const itemsByKey = {};
  Object.values(S.equippedGear).forEach((item) => {
    if (!item) return;
    const rawKey = getBonusKeyForItem(item);
    const normKey = normalizeKey(rawKey);
    if (!normKey) return;
    counts[normKey] = (counts[normKey] || 0) + 1;
    (itemsByKey[normKey] ||= []).push(item.name);
  });

  const holder = document.getElementById('bonusDisplay');
  if (!holder) return;

  if (!Object.keys(counts).length) {
    holder.innerHTML =
      '<p style="text-align:center;color:#888;grid-column:1/-1;">No set bonuses active</p>';
    return;
  }

  // Build compact containers
  let html = '<div class="set-grid">';

  // Sort by preferred order using the display name (set if present, else tier)
  const normKeysSorted = Object.keys(counts).sort((a, b) => {
    const aName = (S.setBonusIndex[a]?.displayKey || a);
    const bName = (S.setBonusIndex[b]?.displayKey || b);
    const ia = setOrderIndex(aName);
    const ib = setOrderIndex(bName);
    if (ia !== ib) return ia - ib;
    return aName.localeCompare(bName);
  });

  normKeysSorted.forEach((normKey) => {
    const count = counts[normKey];
    const entry = S.setBonusIndex[normKey];
    const displayName = entry?.displayKey || normKey;

    const lines = [
      { th: '2/2', pc: 2, text: entry?.pieces?.[2] || '—' },
      { th: '4/4', pc: 4, text: entry?.pieces?.[4] || '—' },
      { th: '6/6', pc: 6, text: entry?.pieces?.[6] || '—' },
    ];

    html += `
      <div class="set-box">
        <div class="set-title">
          <span>${displayName}</span>
          <span class="count">${count}/6</span>
        </div>
        <div class="set-lines">
          ${lines.map(line => `
            <div class="set-line ${count >= line.pc && line.text !== '—' ? 'active' : 'inactive'}">
              <div class="th">${line.th}</div>
              <div class="desc">${line.text}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });

  html += '</div>';
  holder.innerHTML = html;
}


  // Storage
  function saveToLocalStorage() {
    try { localStorage.setItem('evonyGearBuild', JSON.stringify(S.equippedGear)); } catch {}
  }
  function loadFromLocalStorage() {
    try {
      const s = localStorage.getItem('evonyGearBuild');
      if (!s) return;
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') S.equippedGear = parsed;
    } catch {}
  }

  // Close modal on backdrop click
  window.addEventListener('click', (e) => {
    const modal = document.getElementById('itemModal');
    if (e.target === modal) window.closeModal();
  });

  // Initialize
  document.addEventListener('DOMContentLoaded', async () => {
    await loadAllData();
    loadFromLocalStorage();
    updateGearDisplay();
    updateStatsDisplay();
    updateSetBonuses();
  });
})();
