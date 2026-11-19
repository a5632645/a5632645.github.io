let buttons = document.querySelectorAll(".hideable-btn")
for (let i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function() {
        let id = buttons[i].id;
        let d = document.querySelector("#"+id+"-div");
        if (d.classList.contains("invisable")) {
            d.classList.remove("invisable");
            buttons[i].textContent = "隐藏";
        }
        else {
            buttons[i].textContent = "显示";
            d.classList.add("invisable");
        }
    });
    buttons[i].textContent = "显示";
}

let flash_links = document.querySelectorAll(".flash-link");
for (let i = 0; i < flash_links.length; i++) {
    flash_links[i].addEventListener("click", function() {
        let target = flash_links[i].getAttribute('href');
        let item = document.querySelector(target)
        item.classList.add('flash-animation');
        setTimeout(function() {
            item.classList.remove('flash-animation');
        }, 2000);
    });
}

const sectionTitles = document.querySelectorAll('.section-title');
const pageHeader = document.querySelector('.page-header');

// Expose the measured header height to CSS so the catalog and
// anchor scrolling line up right below the sticky header.
function updateHeaderHeight() {
    if (pageHeader) {
        document.documentElement.style.setProperty(
            '--page-header-height',
            pageHeader.offsetHeight + 'px'
        );
    }
}

updateHeaderHeight();
window.addEventListener('resize', updateHeaderHeight);
window.addEventListener('load', updateHeaderHeight);

// Pages without sections get no catalog.
if (sectionTitles.length > 0) {
    document.body.classList.add('has-catalog');

    const pageBody = document.querySelector('.page-body') || document.body;
    pageBody.insertAdjacentHTML('afterbegin', `
        <nav class="catalog" aria-label="Catalog">
            <button class="catalog-label" type="button" aria-expanded="true" aria-controls="catalog-list">Catalog</button>
            <div class="catalog-list" id="catalog-list"></div>
        </nav>
    `);

    const ul = document.querySelector('.catalog-list');
    const catalogEntries = [];

    sectionTitles.forEach(function(item) {
        const target = item.parentElement && item.parentElement.tagName === 'SECTION'
            ? item.parentElement
            : item;

        const link = document.createElement('a');
        link.href = 'javascript:void(0)';
        link.textContent = item.textContent;
        link.onclick = function() {
            target.scrollIntoView();
        };
        ul.appendChild(link);
        catalogEntries.push({ link: link, target: target });
    });

    // Highlight the section currently under the sticky header.
    function updateActiveEntry() {
        const offset = (pageHeader ? pageHeader.offsetHeight : 0) + 12;
        let activeIndex = 0;

        for (let i = 0; i < catalogEntries.length; i++) {
            if (catalogEntries[i].target.getBoundingClientRect().top <= offset) {
                activeIndex = i;
            } else {
                break;
            }
        }

        // Near the bottom of a scrollable page the last
        // (possibly short) section wins.
        const scrollHeight = document.documentElement.scrollHeight;
        if (scrollHeight > window.innerHeight + 1 &&
            window.innerHeight + window.scrollY >= scrollHeight - 2) {
            activeIndex = catalogEntries.length - 1;
        }

        for (let i = 0; i < catalogEntries.length; i++) {
            catalogEntries[i].link.classList.toggle('active', i === activeIndex);
        }
    }

    window.addEventListener('scroll', updateActiveEntry, { passive: true });
    window.addEventListener('resize', updateActiveEntry);
    window.addEventListener('load', updateActiveEntry);

    // Re-evaluate when late content (images, MathJax) changes page height.
    if ('ResizeObserver' in window) {
        new ResizeObserver(updateActiveEntry).observe(document.body);
    }

    updateActiveEntry();

    // On narrow screens the label toggles the floating list;
    // on wide screens the list is always visible.
    const catalog = document.querySelector('.catalog');
    const catalogLabel = catalog.querySelector('.catalog-label');
    const narrowScreen = window.matchMedia('(max-width: 767px)');

    function syncCatalogState() {
        const expanded = !narrowScreen.matches || catalog.classList.contains('open');
        catalogLabel.setAttribute('aria-expanded', String(expanded));
    }

    catalogLabel.addEventListener('click', function() {
        if (!narrowScreen.matches) {
            return;
        }
        catalog.classList.toggle('open');
        syncCatalogState();
    });

    narrowScreen.addEventListener('change', function() {
        catalog.classList.remove('open');
        syncCatalogState();
    });

    syncCatalogState();
}
