let titles = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
let mulu = document.querySelector('.mulu_container').firstElementChild;
for (let i = 0; i < titles.length; i++) {
    let a = document.createElement('a');
    titles[i].id = titles[i].textContent;
    a.href = '#' + titles[i].id;
    a.textContent = titles[i].textContent;
    a.style.display = 'block';
    a.style.textDecoration = 'none';
    a.style.color = 'green';
    mulu.appendChild(a)
}

let mulu_btn = document.querySelector('.mulu-button');
mulu_btn.addEventListener('click', function() {
    if (mulu.classList.contains('invisable')) {
        mulu.classList.remove('invisable');
        mulu_btn.textContent = '隐藏目录';
    }
    else {
        mulu.classList.add('invisable');
        mulu_btn.textContent = '显示目录';
    }
});