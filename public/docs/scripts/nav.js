(function() {

// Mark current page in nav based on URL only
function markCurrentPage() {
  var file = location.pathname.split('/').pop();
  var hash = location.hash;
  var target = file + hash;

  // Remove all existing highlights
  document.querySelectorAll('.nav-current').forEach(function(el) {
    el.classList.remove('nav-current');
  });

  // Find and mark matching links
  var found = false;
  document.querySelectorAll('nav a').forEach(function(a) {
    var href = a.getAttribute('href');
    if (!href) return;

    // Mark if href matches file (parent module) OR file+hash (specific method)
    if (href === file || (hash && href === target)) {
      found = true;
      a.classList.add('nav-current');
      a.style.setProperty('color', '#60a5fa', 'important');
      a.style.setProperty('font-weight', 'bold', 'important');

      // Make parent LI visible
      var li = a.parentElement;
      if (li && li.tagName === 'LI') {
        li.style.display = 'block';
        li.style.visibility = 'visible';
      }

      // Walk up and make ALL ancestors visible
      var el = a.parentElement;
      while (el && el.tagName !== 'NAV') {
        el.style.setProperty('display', 'block', 'important');

        if (el.tagName === 'LI' && el.classList.contains('nav-list-toggle')) {
          el.classList.add('expanded');
          // Also make the child UL and its LIs visible
          var childUl = el.querySelector(':scope > ul');
          if (childUl) {
            childUl.style.setProperty('display', 'block', 'important');
            // Make all child LIs visible too
            childUl.querySelectorAll(':scope > li').forEach(function(childLi) {
              childLi.style.setProperty('display', 'block', 'important');
            });
          }
        }

        // Expand H3 section if UL is direct child of H3
        if (el.tagName === 'UL') {
          var prev = el.previousElementSibling;
          if (prev && prev.tagName === 'H3') {
            prev.setAttribute('data-collapsed', 'false');
            var toggle = prev.querySelector('.section-toggle');
            if (toggle) toggle.textContent = ' -';
          }
        }

        el = el.parentElement;
      }
    }
  });
}

// HTML escape function to prevent XSS
function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function scrollToNavItem() {
  var path = window.location.href.split('/').pop().replace(/\.html.*/, '');
  document.querySelectorAll('nav a').forEach(function(link) {
    if (!link.attributes.href) return;
    var href = link.attributes.href.value.replace(/\.html.*/, '');
    if (path === href) {
      link.scrollIntoView({block: 'center'});
      return;
    }
  })
}

scrollToNavItem();

// Highlight search terms on page load if ?search= parameter exists
// With navigation between multiple matches
var searchHighlights = [];
var currentHighlightIndex = 0;
var searchNavBar = null;

function highlightSearchTerms() {
  var urlParams = new URLSearchParams(window.location.search);
  var searchQuery = urlParams.get('search');
  if (!searchQuery) return;

  // Sanitize search query - only allow alphanumeric and basic punctuation
  searchQuery = searchQuery.replace(/[<>\"'&]/g, '');

  var mainContent = document.getElementById('main');
  if (!mainContent) return;

  var searchLower = searchQuery.toLowerCase();

  // Find all text nodes and highlight matches
  var walker = document.createTreeWalker(
    mainContent,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  var textNodes = [];
  var node;
  while (node = walker.nextNode()) {
    if (node.nodeValue.toLowerCase().includes(searchLower)) {
      textNodes.push(node);
    }
  }

  searchHighlights = [];
  textNodes.forEach(function(textNode) {
    var text = textNode.nodeValue;
    var lowerText = text.toLowerCase();
    var index = lowerText.indexOf(searchLower);

    if (index > -1 && textNode.parentNode) {
      var span = document.createElement('span');
      span.innerHTML = escapeHtml(text.substring(0, index)) +
        '<mark class="search-highlight">' + escapeHtml(text.substring(index, index + searchQuery.length)) + '</mark>' +
        escapeHtml(text.substring(index + searchQuery.length));
      textNode.parentNode.replaceChild(span, textNode);

      var highlight = span.querySelector('.search-highlight');
      if (highlight) {
        searchHighlights.push(highlight);
      }
    }
  });

  // Create navigation bar if multiple matches found
  if (searchHighlights.length > 1) {
    createSearchNavBar(searchQuery);
  }

  // If URL has an anchor (hash), scroll to that element instead of first highlight
  var hasAnchor = window.location.hash && window.location.hash.length > 1;
  if (hasAnchor) {
    // Let browser handle anchor scrolling
  } else if (searchHighlights.length > 0) {
    currentHighlightIndex = 0;
    setTimeout(function() {
      goToHighlight(0);
    }, 100);
  }

  // Pre-fill search input but don't trigger new search
  var searchInput = document.getElementById('nav-search');
  if (searchInput) {
    searchInput.value = searchQuery;
  }
}

function createSearchNavBar(query) {
  if (searchNavBar) {
    searchNavBar.remove();
  }

  searchNavBar = document.createElement('div');
  searchNavBar.id = 'search-nav-bar';
  searchNavBar.style.cssText = 'position: fixed; top: 10px; right: 20px; background: #2a2a2a; border: 1px solid #404040; border-radius: 6px; padding: 8px 12px; display: flex; align-items: center; gap: 10px; z-index: 1000; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);';

  var querySpan = document.createElement('span');
  querySpan.style.cssText = 'color: #888; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
  querySpan.textContent = '"' + query + '"';
  searchNavBar.appendChild(querySpan);

  var counter = document.createElement('span');
  counter.id = 'search-nav-counter';
  counter.style.cssText = 'color: #60a5fa; font-weight: bold;';
  counter.textContent = '1 / ' + searchHighlights.length;
  searchNavBar.appendChild(counter);

  var prevBtn = document.createElement('button');
  prevBtn.textContent = '<';
  prevBtn.title = 'Previous match (Arrow Up)';
  prevBtn.style.cssText = 'background: #404040; border: none; color: white; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: bold;';
  prevBtn.addEventListener('click', function() { navigateHighlight(-1); });
  searchNavBar.appendChild(prevBtn);

  var nextBtn = document.createElement('button');
  nextBtn.textContent = '>';
  nextBtn.title = 'Next match (Arrow Down)';
  nextBtn.style.cssText = 'background: #404040; border: none; color: white; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: bold;';
  nextBtn.addEventListener('click', function() { navigateHighlight(1); });
  searchNavBar.appendChild(nextBtn);

  var closeBtn = document.createElement('button');
  closeBtn.textContent = 'X';
  closeBtn.title = 'Close search (Escape)';
  closeBtn.style.cssText = 'background: #dc2626; border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer; margin-left: 5px;';
  closeBtn.addEventListener('click', closeSearchNav);
  searchNavBar.appendChild(closeBtn);

  document.body.appendChild(searchNavBar);
  document.addEventListener('keydown', handleSearchKeydown);
}

function handleSearchKeydown(e) {
  if (!searchNavBar) return;

  if (e.key === 'ArrowDown' || e.key === 'F3') {
    e.preventDefault();
    navigateHighlight(1);
  } else if (e.key === 'ArrowUp' || (e.key === 'F3' && e.shiftKey)) {
    e.preventDefault();
    navigateHighlight(-1);
  } else if (e.key === 'Escape') {
    closeSearchNav();
  }
}

function navigateHighlight(direction) {
  if (searchHighlights.length === 0) return;

  currentHighlightIndex += direction;
  if (currentHighlightIndex >= searchHighlights.length) {
    currentHighlightIndex = 0;
  } else if (currentHighlightIndex < 0) {
    currentHighlightIndex = searchHighlights.length - 1;
  }

  goToHighlight(currentHighlightIndex);
}

function goToHighlight(index) {
  searchHighlights.forEach(function(h) {
    h.style.outline = '';
    h.style.outlineOffset = '';
  });

  var current = searchHighlights[index];
  if (current) {
    current.style.outline = '2px solid #60a5fa';
    current.style.outlineOffset = '2px';
    current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  var counter = document.getElementById('search-nav-counter');
  if (counter) {
    counter.textContent = (index + 1) + ' / ' + searchHighlights.length;
  }
}

function closeSearchNav() {
  if (searchNavBar) {
    searchNavBar.remove();
    searchNavBar = null;
  }

  searchHighlights.forEach(function(h) {
    if (h.parentNode) {
      var text = document.createTextNode(h.textContent);
      h.parentNode.replaceChild(text, h);
    }
  });
  searchHighlights = [];

  document.removeEventListener('keydown', handleSearchKeydown);

  var url = new URL(window.location);
  url.searchParams.delete('search');
  history.replaceState(null, '', url);
}

highlightSearchTerms();

// Collapsible h3 section headers (Classes, Modules, etc.)
// Home, ShippingManager, COPILOT Tutorials, COPILOT DOCUMENTATION start expanded; others collapsed
var expandedSections = ['Home', 'ShippingManager', 'COPILOT Tutorials', 'COPILOT DOCUMENTATION'];
document.querySelectorAll('nav h3').forEach(function(header) {
  var ul = header.nextElementSibling;
  if (!ul || ul.tagName !== 'UL') return;

  // Check if this section should start expanded
  var headerText = header.textContent.trim();
  var shouldExpand = expandedSections.some(function(name) {
    return headerText.indexOf(name) > -1;
  });

  // Add toggle indicator
  var toggle = document.createElement('span');
  toggle.className = 'section-toggle';
  toggle.textContent = shouldExpand ? ' -' : ' +';
  toggle.style.cssText = 'float: right; font-weight: bold;';
  header.appendChild(toggle);
  header.style.cursor = 'pointer';
  header.setAttribute('data-collapsed', shouldExpand ? 'false' : 'true');

  // Start state based on shouldExpand
  ul.style.display = shouldExpand ? 'block' : 'none';

  header.addEventListener('click', function() {
    var isCollapsed = header.getAttribute('data-collapsed') === 'true';

    if (isCollapsed) {
      ul.style.display = 'block';
      header.setAttribute('data-collapsed', 'false');
      toggle.textContent = ' -';
    } else {
      ul.style.display = 'none';
      header.setAttribute('data-collapsed', 'true');
      toggle.textContent = ' +';
    }
  });
});

// Expandable list items - all li elements that have a nested ul
document.querySelectorAll('nav li').forEach(function(li) {
  var childUl = null;
  for (var i = 0; i < li.children.length; i++) {
    if (li.children[i].tagName === 'UL') {
      childUl = li.children[i];
      break;
    }
  }
  if (!childUl) return;

  var link = null;
  for (var j = 0; j < li.children.length; j++) {
    if (li.children[j].tagName === 'A') {
      link = li.children[j];
      break;
    }
  }
  if (!link) return;

  var linkHref = link.getAttribute('href');
  var isNavigationLink = linkHref && linkHref.includes('.html');

  li.classList.add('nav-list-toggle');
  childUl.style.display = 'none';

  if (!isNavigationLink) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();

      if (li.classList.contains('expanded')) {
        li.classList.remove('expanded');
        childUl.style.display = 'none';
      } else {
        li.classList.add('expanded');
        childUl.style.display = 'block';
        for (var k = 0; k < childUl.children.length; k++) {
          if (childUl.children[k].tagName === 'LI') {
            childUl.children[k].style.display = 'block';
          }
        }
      }
    });
  }
});

// Search functionality with full-text search index
var searchInput = document.getElementById('nav-search');
var searchIndex = null;
var searchResultsContainer = null;

if (searchInput) {
  var basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
  var searchIndexUrl = basePath + 'search-index.json';

  fetch(searchIndexUrl)
    .then(function(response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function(data) {
      searchIndex = data;
    })
    .catch(function() {
      searchIndex = [];
    });

  // Create wrapper for search input and clear button (don't modify nav position!)
  var searchWrapper = document.createElement('div');
  searchWrapper.style.cssText = 'position: relative; padding: 3px;';
  searchInput.parentNode.insertBefore(searchWrapper, searchInput);
  searchWrapper.appendChild(searchInput);
  searchInput.style.cssText = 'width: 100%; box-sizing: border-box; padding: 6px 28px 6px 8px; background: #2a2a2a; border: 1px solid #404040; border-radius: 3px; color: #e0e0e0; font-size: 13px;';

  searchResultsContainer = document.createElement('div');
  searchResultsContainer.id = 'search-results';
  searchResultsContainer.style.cssText = 'display: none; max-height: 300px; overflow-y: auto; background: #2a2a2a; border: 1px solid #404040; border-radius: 3px; margin: 0; padding: 0; position: relative; z-index: 100;';
  searchWrapper.parentNode.insertBefore(searchResultsContainer, searchWrapper.nextSibling);

  // Clear button next to search input
  var clearBtn = document.createElement('button');
  clearBtn.id = 'search-clear-btn';
  clearBtn.textContent = 'X';
  clearBtn.title = 'Clear search';
  clearBtn.style.cssText = 'position: absolute; right: 5px; top: 50%; transform: translateY(-50%); background: #404040; border: none; color: #888; width: 18px; height: 18px; border-radius: 50%; cursor: pointer; font-size: 12px; line-height: 1; padding: 0; display: none;';
  clearBtn.addEventListener('click', function() {
    searchInput.value = '';
    searchResultsContainer.style.display = 'none';
    searchResultsContainer.innerHTML = '';
    clearBtn.style.display = 'none';
  });
  searchWrapper.appendChild(clearBtn);

  searchInput.addEventListener('input', function() {
    var query = this.value.toLowerCase().trim();

    // Update clear button visibility
    clearBtn.style.display = query ? 'block' : 'none';

    // Hide search results when empty - do nothing else
    if (!query) {
      searchResultsContainer.style.display = 'none';
      searchResultsContainer.innerHTML = '';
      return;
    }

    if (!searchIndex) return;

    var indexResults = searchIndex.filter(function(item) {
      var searchText = (item.name + ' ' + item.longname + ' ' + (item.description || '')).toLowerCase();
      return searchText.includes(query);
    }).slice(0, 20);

    if (indexResults.length > 0) {
      var resultsHtml = '';
      indexResults.forEach(function(item) {
        var typeLabels = {
          'shippingmanager': 'ShippingManager',
          'readme': 'Readme',
          'tutorial': 'Tutorial',
          'module': 'Module',
          'class': 'Class',
          'method': 'Method',
          'namespace': 'Namespace',
          'function': 'Function',
          'global': 'Global'
        };
        var typeLabel = typeLabels[item.type] || item.type.charAt(0).toUpperCase() + item.type.slice(1);
        var typeClass = 'search-type-' + item.type;
        var targetUrl = item.url;
        var hashIndex = targetUrl.indexOf('#');
        if (hashIndex > -1) {
          targetUrl = targetUrl.substring(0, hashIndex) + '?search=' + encodeURIComponent(query) + targetUrl.substring(hashIndex);
        } else {
          targetUrl = targetUrl + '?search=' + encodeURIComponent(query);
        }
        resultsHtml += '<a href="' + escapeHtml(targetUrl) + '" class="search-result-item">';
        resultsHtml += '<span class="search-result-type ' + escapeHtml(typeClass) + '">' + escapeHtml(typeLabel) + '</span>';
        resultsHtml += '<span class="search-result-name">' + escapeHtml(item.name) + '</span>';
        resultsHtml += '</a>';
      });
      searchResultsContainer.innerHTML = resultsHtml;
      searchResultsContainer.style.display = 'block';
    } else {
      searchResultsContainer.innerHTML = '<div class="search-no-results">No results found</div>';
      searchResultsContainer.style.display = 'block';
    }
  });
}

// Run markCurrentPage after everything else with a delay
setTimeout(markCurrentPage, 100);

// Scroll to anchor on page load if hash is present
if (location.hash) {
  setTimeout(function() {
    var target = document.getElementById(location.hash.substring(1));
    if (target) {
      target.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }, 150);
}

})();
