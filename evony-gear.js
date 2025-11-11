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
const BUFF_TYPES = ['attack', 'defense', 'hp', 'debuff'];
const DEBUFF_TYPES = ['attack', 'defense', 'hp'];

// Filter state
const filterState = {
  activeTroop: null,
  activeBuff: null,
  activeDebuffType: null,
  itemTier: 'standard' // 'standard' or 'civilization'
};

// Check if an attribute contains enemy/debuff language
function isDebuffAttribute(attrText) {
  const lower = attrText.toLowerCase();
  return lower.includes('enemy') || lower.includes('opposing');
}

// Extract troop type from attribute text
function extractTroopFromAttr(attrText) {
  const lower = attrText.toLowerCase();
  for (const troop of TROOP_TYPES) {
    if (lower.includes(troop)) {
      return troop;
    }
  }
  return null;
}

// Extract buff type from attribute text
function extractBuffFromAttr(attrText) {
  const lower = attrText.toLowerCase();
  if (lower.includes('attack')) return 'attack';
  if (lower.includes('defense') || lower.includes('defence')) return 'defense';
  if (lower.includes('hp') || lower.includes('health')) return 'hp';
  return null;
}

// Check if an item matches the active filters using AND logic (modal filtering)
// - Excludes "Attacking ..." conditional lines for normal buff filters (Attack/Defense/HP)
// - Supports multi-troop attributes (e.g., "Ground and Mounted …")
// - Supports multi-buff attributes (e.g., "Attack and Defense …")
// - Debuff filter path is preserved
// Check if an item matches the active filters using AND logic (modal filtering)
function itemMatchesFilters(item) {
  // Tier filter first
  const itemTierType = (item.tier || '').toLowerCase();
  const isCivilization = itemTierType.includes('civilization');
  const isStandard = !isCivilization;

  if (filterState.itemTier === 'civilization' && !isCivilization) return false;
  if (filterState.itemTier === 'standard' && !isStandard) return false;

  const attrLines = (getAttributesString(item) || '')
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);

  // Helper keyword checks
  const hasAttack = (s) => /\battack\b/i.test(s);
  const hasDefense = (s) => /\bdef(ense)?\b/i.test(s);
  const hasHP = (s) => /\bhp\b|\bhealth\b/i.test(s);

  // Optional: treat "All Troop ..." as matching any troop
  const includeAllTroopAsMatch = true;

  // If Debuff filter is selected, allow it to work with/without troop
  if (filterState.activeBuff === 'debuff') {
    const matchesAnyDebuffLine = attrLines.some(line => {
      if (!isDebuffAttribute(line)) return false; // must be debuff line

      // If a Debuff Type was selected, it must match the line
      if (filterState.activeDebuffType) {
        if (filterState.activeDebuffType === 'attack' && !hasAttack(line)) return false;
        if (filterState.activeDebuffType === 'defense' && !hasDefense(line)) return false;
        if (filterState.activeDebuffType === 'hp' && !hasHP(line)) return false;
      }

      // If a troop is selected, require the line to mention that troop
if (filterState.activeTroop) {
  const lower = line.toLowerCase();
  const allTroopOk = includeAllTroopAsMatch && /\ball\s+troops?\b/.test(lower);
  const troopOk = allTroopOk || lower.includes(filterState.activeTroop);
  if (!troopOk) return false;
}


      return true;
    });

    return matchesAnyDebuffLine;
  }

  // If no troop filter and not in Debuff mode: show all (tier-only filter)
  if (!filterState.activeTroop) return true;

  // Normal buff path (Attack/Defense/HP): exclude Attacking conditionals and debuffs
  const matchesAnyNormalLine = attrLines.some(line => {
    if (isDebuffAttribute(line)) return false; // debuff lines don't belong here

    const cls = classifyStat(line);
    if (cls.attacking) return false; // exclude “Attacking ...” in normal buff search

    // Troop match (supports multi-troop lines); allow "All Troop" if desired
    const troopOk = (cls.isAllTroop && includeAllTroopAsMatch) ||
                    (Array.isArray(cls.troops) && cls.troops.includes(filterState.activeTroop));
    if (!troopOk) return false;

    // Buff type match
    if (!filterState.activeBuff) return true; // troop-only filter
    if (filterState.activeBuff === 'attack')  return hasAttack(line);
    if (filterState.activeBuff === 'defense') return hasDefense(line);
    if (filterState.activeBuff === 'hp')      return hasHP(line);

    return false;
  });

  return matchesAnyNormalLine;
}

// Apply filters to visible items
function applyFilters() {
  const modal = document.getElementById('itemModal');
  if (!modal) return;

  document.querySelectorAll('.tier-section').forEach(section => {
    const cards = section.querySelectorAll('.item-card');
    let visibleCount = 0;

    cards.forEach(card => {
      const idx = parseInt(card.dataset.itemIdx, 10);
      if (idx === -1) {
        // Keep "Remove Item" visible always
        card.style.display = 'block';
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
  });

  updateTierCounts();
}

// Toggle troop filter
window.toggleTroopFilter = function(troop) {
  if (filterState.activeTroop === troop) {
    // Turn off
    filterState.activeTroop = null;
    // DON'T reset buff filters here - that's the issue!
    // filterState.activeBuff = null;
    // filterState.activeDebuffType = null;
  } else {
    // Turn on
    filterState.activeTroop = troop;
    // DON'T reset buff filters here either!
    // filterState.activeBuff = null;
    // filterState.activeDebuffType = null;
  }
  
  updateFilterButtons();
  applyFilters();
};

// Toggle buff filter
window.toggleBuffFilter = function(buff) {
  // Allow Debuff even without troop; require troop for Attack/Defense/HP
  if (!filterState.activeTroop && buff !== 'debuff') return;

  if (filterState.activeBuff === buff) {
    // Turn off
    filterState.activeBuff = null;
    filterState.activeDebuffType = null;
  } else {
    // Turn on
    filterState.activeBuff = buff;
    filterState.activeDebuffType = null;
  }

  updateFilterButtons();
  applyFilters();
};

// Toggle debuff type filter (no troop required)
window.toggleDebuffTypeFilter = function(debuffType) {
  if (filterState.activeBuff !== 'debuff') return;

  filterState.activeDebuffType =
    (filterState.activeDebuffType === debuffType) ? null : debuffType;

  updateFilterButtons();
  applyFilters();
};

// Toggle item tier filter (Standard vs Civilization)
window.toggleItemTier = function(tier) {
  filterState.itemTier = tier;
  filterState.activeTroop = null;
  filterState.activeBuff = null;
  filterState.activeDebuffType = null;
  
  updateFilterButtons();
  
  // Reload modal content with new tier filter
  if (S.currentSlot) {
    window.openGearModal(S.currentSlot);
  }
};

// Update button states
function updateFilterButtons() {
  // Item tier buttons
  ['standard', 'civilization'].forEach(tier => {
    const btn = document.getElementById(`filter-tier-${tier}`);
    if (btn) {
      if (filterState.itemTier === tier) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });
  
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
  // Show row if a troop is selected OR Debuff is selected
  buffRow.style.display = (filterState.activeTroop || filterState.activeBuff === 'debuff') ? 'flex' : 'none';
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
  
  // Debuff type buttons
  const debuffTypeRow = document.getElementById('debuffTypeFilterRow');
if (debuffTypeRow) {
  debuffTypeRow.style.display = (filterState.activeBuff === 'debuff') ? 'flex' : 'none';
}
  
  DEBUFF_TYPES.forEach(debuffType => {
    const btn = document.getElementById(`filter-debuff-${debuffType}`);
    if (btn) {
      if (filterState.activeDebuffType === debuffType) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });
}

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

// Check if a buff is "when defending"
function isWhenDefendingBuff(name) {
  const norm = normStatKey(name);
  return /^when defending\b/.test(norm) || /^while defending\b/.test(norm);
}

// Check if a buff is "in-city"
function isInCityBuff(name) {
  const norm = normStatKey(name);
  return /^in[-\s]?city\b/.test(norm);
}

// Determine if a stat line should be included based on reinforcement/wall filters
function shouldIncludeLine(line, domain) {
  const name = line?.name || '';
  const isAttacking = isAttackingBuff(name);
  const inCity = isInCityBuff(name);
  const whenDefending = isWhenDefendingBuff(name);

  // 1) Reinforcement mode (hide attacking buffs)
  if (wallGeneralFilters.hideAttacking && isAttacking) {
    return false;
  }

  // 2) Wall General mode
  if (wallGeneralFilters.showAsWallGeneral) {
    // Allow:
    // - In-City buffs
    // - "When/While Defending" buffs
    // - Standard (non-conditional) buffs
    // Disallow:
    // - Attacking buffs
    if (isAttacking) return false;
    if (inCity) return true;
    if (whenDefending) return true;

    // Standard buff (no “attacking”, no “in-city”, no “when defending”)
    return true;
  }

  // 3) Normal mode: include everything by default
  return true;
}

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

// Recompute the "X items" badge for each tier header based on visible cards
function updateTierCounts() {
  document.querySelectorAll('#itemModal .tier-section').forEach(section => {
    const count = Array.from(section.querySelectorAll('.item-card'))
      .filter(card => {
        // Ignore the "Remove Item" card (idx === -1)
        const idx = parseInt(card.dataset.itemIdx, 10);
        if (isNaN(idx) || idx < 0) return false;

        // Check visibility
        return card.style.display !== 'none';
      }).length;

    const badge = section.querySelector('.tier-count');
    if (badge) {
      badge.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;
    }

    // Hide entire section if none visible
    section.style.display = count > 0 ? 'block' : 'none';
  });
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
  
  // Reset buff filters when opening modal, but keep tier filter
  filterState.activeTroop = null;
  filterState.activeBuff = null;
  filterState.activeDebuffType = null;
  
  const modal = document.getElementById('itemModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');

  if (!modal || !modalTitle || !modalBody) {
    showError('Modal elements not found in HTML.');
    return;
  }

  modalTitle.textContent = `Select ${SLOT_LABELS[slot] || slot}`;

  // Items for this slot, filtered by tier type
  const slotItems = S.allItems.filter((item) => {
    if ((item.slot || '').toLowerCase() !== slot) return false;
    
    // Check tier filter
    const itemTierType = (item.tier || '').toLowerCase();
    const isCivilization = itemTierType.includes('civilization');
    const isStandard = !isCivilization;
    
    if (filterState.itemTier === 'civilization') return isCivilization;
    if (filterState.itemTier === 'standard') return isStandard;
    
    return true;
  });

  // Prefer grouping by setname if any item has it; else group by tier
  const itemsHaveSet = slotItems.some((it) => getItemSetName(it).length > 0);
  const groupGetter = (it) => (itemsHaveSet ? (getItemSetName(it) || 'Unknown Set') : (it.tier || 'Unknown Tier'));

  // Build groups
  const groups = {};
  slotItems.forEach((item) => {
    const key = groupGetter(item);
    (groups[key] ||= []).push(item);
  });

  // Item tier filter buttons HTML
  const tierFilterHtml = `
    <div class="filter-section">
      <div class="filter-label">Item Type:</div>
      <div class="filter-buttons" id="tierFilterRow">
        <button 
          class="filter-btn" 
          id="filter-tier-standard"
          onclick="toggleItemTier('standard')"
        >
          Standard
        </button>
        <button 
          class="filter-btn" 
          id="filter-tier-civilization"
          onclick="toggleItemTier('civilization')"
        >
          Civilization
        </button>
      </div>
    </div>
  `;

  // Troop filter buttons HTML
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
  `;

  // Buff filter buttons HTML
  const buffFilterHtml = `
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

  // Debuff type filter buttons HTML
  const debuffTypeFilterHtml = `
    <div class="filter-section" id="debuffTypeFilterRow" style="display:none;">
      <div class="filter-label">Debuff Type:</div>
      <div class="filter-buttons">
        ${DEBUFF_TYPES.map(debuffType => `
          <button 
            class="filter-btn" 
            id="filter-debuff-${debuffType}"
            onclick="toggleDebuffTypeFilter('${debuffType}')"
          >
            ${debuffType.charAt(0).toUpperCase() + debuffType.slice(1)}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  let html = `
    <div class="search-container">
      <input type="text" id="itemSearch" class="search-input" placeholder="🔍 Search items..." onkeyup="filterItems()">
    </div>
    ${tierFilterHtml}
    ${troopFilterHtml}
    ${buffFilterHtml}
    ${debuffTypeFilterHtml}
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
  const countLabel = `${filteredCount} ${filteredCount === 1 ? 'item' : 'items'}`;

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
  html += '<p style="text-align:center;color:#888;">No items available for this slot</p>';
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
    const idx = parseInt(card.dataset.itemIdx, 10);
    const isRemove = idx === -1;

    // Search match
    const searchMatches = (
      isRemove ||
      name.includes(q) ||
      attrHidden.includes(q) ||
      attrListText.includes(q)
    );

    // Filter match
    const modalBody = document.getElementById('modalBody');
    const item = (idx >= 0 && modalBody?._itemsCache) ? modalBody._itemsCache[idx] : null;
    const filterMatches = !item || itemMatchesFilters(item);

    card.style.display = (searchMatches && filterMatches) ? 'block' : 'none';
  });

  // Refresh counts and section visibility
  updateTierCounts();
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

// Format stat values with proper sign handling
// - Positive: "+45%"
// - Negative: "-45%" (no extra plus)
// - decimals: optional fixed decimals for percents in substat grids
function formatStatValue(value, isPercent, opts = {}) {
  const decimals = opts.decimals ?? null;

  const magnitudeStr = decimals !== null
    ? Math.abs(Number(value)).toFixed(decimals)
    : Math.abs(Number(value)).toLocaleString();

  const sign = Number(value) < 0 ? '-' : '+';
  return `${sign}${magnitudeStr}${isPercent ? '%' : ''}`;
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

// Extract multiple troop types from attribute text
function extractTroopsFromAttr(attrText) {
  const lower = attrText.toLowerCase();
  const foundTroops = [];
  
  // Check for explicit "and" combinations like "ground and mounted"
  const andPattern = /(ground|ranged|mounted|siege)\s+and\s+(ground|ranged|mounted|siege)/i;
  const andMatch = lower.match(andPattern);
  
  if (andMatch) {
    foundTroops.push(andMatch[1]);
    foundTroops.push(andMatch[2]);
    return foundTroops;
  }
  
  // Check for comma-separated like "ground, mounted"
  const commaPattern = /(ground|ranged|mounted|siege)\s*,\s*(ground|ranged|mounted|siege)/i;
  const commaMatch = lower.match(commaPattern);
  
  if (commaMatch) {
    foundTroops.push(commaMatch[1]);
    foundTroops.push(commaMatch[2]);
    return foundTroops;
  }
  
  // Single troop type
  for (const troop of TROOP_TYPES) {
    if (lower.includes(troop)) {
      foundTroops.push(troop);
      break; // Only find the first one if no "and" or comma
    }
  }
  
  return foundTroops;
}

// Parse complex multi-troop, multi-buff attributes
function parseComplexAttribute(attrText) {
  const results = [];
  
  // Check for "When Defending" prefix
  const whenDefendingMatch = attrText.match(/^(when|while)\s+defending\s+(.+)$/i);
  const isDefending = !!whenDefendingMatch;
  const workingText = isDefending ? whenDefendingMatch[2] : attrText;
  
  // Check for "In-City" prefix
  const inCityMatch = workingText.match(/^in[-\s]?city\s+(.+)$/i);
  const isInCity = !!inCityMatch;
  const mainText = isInCity ? inCityMatch[1] : workingText;
  
  // Check for "Attacking" prefix
  const attackingMatch = mainText.match(/^attacking\s+(.+)$/i);
  const isAttacking = !!attackingMatch;
  const contentText = isAttacking ? attackingMatch[1] : mainText;
  
  // Match pattern: "Troop1 and Troop2 Troop Buff1 and Buff2 +Value%"
  // Example: "Mounted and Ranged Troop Attack and Defense +15%"
  const complexPattern = /^((?:ground|ranged|mounted|siege)(?:\s+and\s+(?:ground|ranged|mounted|siege))*)\s+troop(?:'?s?)?\s+((?:attack|defense|hp)(?:\s+and\s+(?:attack|defense|hp))*)\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(%?)$/i;
  
  const match = contentText.trim().match(complexPattern);
  
  if (!match) {
    return null; // Not a complex multi-attribute
  }
  
  const troopsPart = match[1];
  const buffsPart = match[2];
  const valueStr = match[3].replace(/,/g, '');
  const isPercent = match[4] === '%';
  const value = parseFloat(valueStr);
  
  if (isNaN(value)) return null;
  
  // Extract troop types
  const troops = [];
  const troopMatches = troopsPart.toLowerCase().matchAll(/(ground|ranged|mounted|siege)/g);
  for (const m of troopMatches) {
    if (!troops.includes(m[1])) troops.push(m[1]);
  }
  
  // Extract buff types
  const buffs = [];
  const buffMatches = buffsPart.toLowerCase().matchAll(/(attack|defense|hp)/g);
  for (const m of buffMatches) {
    if (!buffs.includes(m[1])) buffs.push(m[1]);
  }
  
  // Determine domain
  let domain = 'field';
  if (isInCity) domain = 'inCity';
  
  // Generate all combinations
  troops.forEach(troop => {
    buffs.forEach(buff => {
      results.push({
        troop,
        buff,
        value,
        isPercent,
        originalText: attrText,
        domain,
        isAttacking,
        isDefending
      });
    });
  });
  
  return results.length > 0 ? results : null;
}

// Determine domain/troop/attacking/substat classification
function classifyStat(rawName) {
  let s = normStatKey(rawName);
  let domain = 'field';
  let attacking = false;
  let defending = false; // NEW: track defending buffs
  let troops = [];
  let substat = 'other';

  // March
  if (/^march size\b/.test(s) || /^march capacity\b/.test(s)) {
    return { domain: 'march', attacking, defending, troops, substat, label: rawName };
  }
  if (/^march speed\b/.test(s)) {
    return { domain: 'march', attacking, defending, troops, substat, label: rawName };
  }

  // When Defending (NEW)
  if (/^when defending\b/.test(s) || /^while defending\b/.test(s)) {
    defending = true;
    domain = 'field'; // Defending buffs apply in field context
    s = s.replace(/^(?:when|while) defending\s+/, '');
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

  // Multi-troop detection: "ground and mounted", "ground, mounted", etc.
  const andPattern = /(ground|ranged|mounted|siege)\s+and\s+(ground|ranged|mounted|siege)\b/;
  const andMatch = s.match(andPattern);
  
  if (andMatch) {
    troops.push(andMatch[1], andMatch[2]);
    s = s.replace(andPattern, '');
  } else {
    // Comma-separated: "ground, mounted"
    const commaPattern = /(ground|ranged|mounted|siege)\s*,\s*(ground|ranged|mounted|siege)\b/;
    const commaMatch = s.match(commaPattern);
    
    if (commaMatch) {
      troops.push(commaMatch[1], commaMatch[2]);
      s = s.replace(commaPattern, '');
    } else {
      // Single troop
      const troopMatch = s.match(/^(ground|ranged|mounted|siege)\b/);
      if (troopMatch) {
        troops.push(troopMatch[1]);
        s = s.replace(/^(ground|ranged|mounted|siege)\s+/, '');
      }
    }
  }

  // Substat detection
  if (/\battack\b/.test(s)) substat = 'attack';
  else if (/\bhp\b/.test(s)) substat = 'hp';
  else if (/\bdef(ense)?\b/.test(s)) substat = 'defense';
  else substat = 'other';

  // All Troop special (applies to all troop types)
  const isAllTroop = /^all\s+troop(s)?\b/.test(normStatKey(rawName));

  return { domain, attacking, defending, troops, substat, isAllTroop, label: rawName };
}

// Check if a stat is a conditional "Attacking" all-troop bonus
function isAttackingAllTroopBonus(rawName) {
  const norm = normStatKey(rawName);
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
function addLine(totals, domain, troop, substat, displayName, value, isPercent, source, replicated = false) {
  if (domain === 'field' || domain === 'inCity') {
    if (!troop) {
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
              <div class="substat-value">${formatStatValue(l.value, l.isPercent, { decimals: 1 })}</div>
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
          <div class="value">${formatStatValue(l.value, l.isPercent)}</div>

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
        <span>Reinforcement</span>
        
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
    const attrString = getAttributesString(item);
    const attrLines = attrString.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    
    attrLines.forEach(attrLine => {
      // First, try to parse as complex multi-troop, multi-buff attribute
      const complexParsed = parseComplexAttribute(attrLine);
      
            if (complexParsed) {
        // Handle complex attributes like "Mounted and Ranged Troop Attack and Defense +15%"
        complexParsed.forEach(parsed => {
          const substat = parsed.buff === 'defense' ? 'defense' : 
                         parsed.buff === 'hp' ? 'hp' : 
                         parsed.buff === 'attack' ? 'attack' : 'other';
          
          addLine(totals, parsed.domain, parsed.troop, substat, parsed.originalText, parsed.value, parsed.isPercent, 'gear', true);
        });
        return;
      }
      
      // Fall back to regular token parsing
      const tokens = getStatTokens(attrLine);
      tokens.forEach(tok => {
        const cls = classifyStat(tok.rawName);
        
        // Check for "Attacking Troop's X" bonuses
        if (isAttackingAllTroopBonus(tok.rawName)) {
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
          // Multi-troop handling: replicate to each troop type
          if (cls.troops.length > 0) {
            cls.troops.forEach(troopType => {
              addLine(totals, cls.domain, troopType, cls.substat, tok.rawName, tok.value, tok.isPercent, 'gear', cls.troops.length > 1);
            });
          } else {
            addLine(totals, cls.domain, null, cls.substat, tok.rawName, tok.value, tok.isPercent, 'gear');
          }
        } else {
          addLine(totals, cls.domain, null, cls.substat, tok.rawName, tok.value, tok.isPercent, 'gear');
        }
      });
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
        const attrLines = text.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        
        attrLines.forEach(attrLine => {
          // First, try to parse as complex multi-troop, multi-buff attribute
          const complexParsed = parseComplexAttribute(attrLine);
          
                    if (complexParsed) {
            // Handle complex attributes
            complexParsed.forEach(parsed => {
              const substat = parsed.buff === 'defense' ? 'defense' : 
                             parsed.buff === 'hp' ? 'hp' : 
                             parsed.buff === 'attack' ? 'attack' : 'other';
              
              addLine(totals, parsed.domain, parsed.troop, substat, parsed.originalText, parsed.value, parsed.isPercent, 'set', true);
            });
            return;
          }

          
          // Fall back to regular token parsing
          const tokens = getStatTokens(attrLine);
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
              // Multi-troop handling: replicate to each troop type
              if (cls.troops.length > 0) {
                cls.troops.forEach(troopType => {
                  addLine(totals, cls.domain, troopType, cls.substat, nameWithTag, tok.value, tok.isPercent, 'set', cls.troops.length > 1);
                });
              } else {
                addLine(totals, 'other', null, cls.substat, nameWithTag, tok.value, tok.isPercent, 'set');
              }
            } else {
              addLine(totals, cls.domain, null, cls.substat, nameWithTag, tok.value, tok.isPercent, 'set');
            }
          });
        });
      }
    });
  });

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
                <div class="value">${formatStatValue(l.value, l.isPercent)}</div>
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
                <div class="value">${formatStatValue(l.value, l.isPercent)}</div>
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
