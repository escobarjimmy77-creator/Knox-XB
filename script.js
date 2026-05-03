// script.js - AnimeSAO Pro Premium Experience v2
import { GoogleGenAI } from "@google/genai";

const API_BASE = '/api';
const SECTIONS_CONFIG = [
    { id: 'latest', title: 'Añadidos Recientemente', type: 'latest', endpoint: 'latest' },
    { id: 'trending', title: 'Animes Populares', type: 'trending', endpoint: 'trending' },
    { id: 'action', title: 'Acción', type: 'genre', endpoint: 'genre/accion' },
    { id: 'comedy', title: 'Comedia', type: 'genre', endpoint: 'genre/comedia' },
    { id: 'romance', title: 'Romance', type: 'genre', endpoint: 'genre/romance' },
    { id: 'fantasy', title: 'Fantasía', type: 'genre', endpoint: 'genre/fantasia' },
    { id: 'isekai', title: 'Isekai', type: 'genre', endpoint: 'genre/isekai' },
    { id: 'drama', title: 'Drama', type: 'genre', endpoint: 'genre/drama' },
    { id: 'shounen', title: 'Shounen', type: 'genre', endpoint: 'genre/shounen' },
    { id: 'mystery', title: 'Misterio', type: 'genre', endpoint: 'genre/misterio' }
];

// ==================== STATE ====================
const AppState = {
    apiKey: 'AIzaSyBVUaP9I-Bb9DEQm7R6amTwuP4LWB-UjHo',
    aiInstance: null,
    aiChat: null,
    aiMessages: [],
    library: (() => { 
        try { 
            const d = JSON.parse(localStorage.getItem('anime_library') || '[]'); 
            return Array.isArray(d) ? d : []; 
        } catch(e) { 
            console.warn('Library corrupted, resetting.');
            return []; 
        } 
    })(),
    history: (() => { 
        try { 
            const d = JSON.parse(localStorage.getItem('anime_history') || '[]'); 
            return Array.isArray(d) ? d : []; 
        } catch(e) { 
            console.warn('History corrupted, resetting.');
            return []; 
        } 
    })(),
    userPreferences: (() => { 
        try { 
            const d = JSON.parse(localStorage.getItem('anime_prefs') || '{}'); 
            return (typeof d === 'object' && d !== null && !Array.isArray(d)) ? d : {}; 
        } catch(e) { 
            return {}; 
        } 
    })(),
    catalogIndex: [], // Store items for AI context
    currentAnime: null,
    currentEpisode: null,
    currentServers: [],
    currentServerIndex: 0,
    playerProgress: {},
    homeSections: new Map(),
    homeLoading: false,
    homeInitialized: false,
    sectionsLoading: new Set(),
    sectionPageCache: new Map(),
    categoryType: null,
    categoryGenre: null,
    categoryPage: 1,
    categoryLoading: false,
    categoryHasMore: true,
    searchTimeout: null,
    searchCache: new Map(),
    playerLoading: false,
    playerError: null,
    seenAnimeIds: new Set(),
    toastTimer: null,
    deferredPrompt: null,
    episodeSortOrder: 1, // 1: ASC, -1: DESC
    currentEpisodePage: 0,
    episodePageSize: 50
};

// ==================== UTILITIES ====================
const $ = (id) => document.getElementById(id);

const showToast = (msg, duration = 2400) => {
    const toast = $('toast');
    if (!toast) return;

    clearTimeout(AppState.toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');

    AppState.toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toast.textContent = '';
    }, duration);
};

const debounce = (fn, ms) => {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const shuffleArray = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

// ==================== RECOMENDACIONES (SENIOR ENGINE v2) ====================
const Recommendations = {
    // k-factor: Sensibilidad al cambio. 
    // 0.98 significa que después de 50 interacciones, un gusto antiguo vale solo 36% de su valor original.
    DECAY_RATE: 0.98, 
    
    init() {
        // Aplicar decaimiento por tiempo transcurrido desde la última sesión
        const lastSession = parseInt(localStorage.getItem('last_session_time') || Date.now());
        const now = Date.now();
        const hoursPassed = (now - lastSession) / (1000 * 60 * 60);
        
        if (hoursPassed > 1) {
            const prefs = AppState.userPreferences;
            // Por cada hora de inactividad, perdemos un 1% de intensidad en los gustos antiguos
            // Esto permite que el usuario empiece "más fresco" después de dormir o no usar la app
            const timeDecay = Math.pow(0.99, hoursPassed);
            Object.keys(prefs).forEach(key => {
                prefs[key] *= timeDecay;
                if (prefs[key] < 0.05) delete prefs[key];
            });
            localStorage.setItem('anime_prefs', JSON.stringify(prefs));
        }
        localStorage.setItem('last_session_time', now.toString());
    },

    track(action, anime) {
        if (!anime || !anime.genres) return;

        const weights = {
            'view': 0.15,     // Curiosidad
            'play': 1.2,      // Intención clara
            'finish': 3.0,    // Compromiso (Retención)
            'library': 4.5    // Interés a largo plazo
        };

        const boost = weights[action] || 0.1;
        const prefs = AppState.userPreferences;

        // Decaimiento por interacción (Taste Shift)
        Object.keys(prefs).forEach(key => {
            prefs[key] *= this.DECAY_RATE;
        });

        anime.genres.forEach(g => {
            const key = g.toLowerCase().trim();
            if (key) {
                // El peso crece de forma logarítmica para evitar que un solo género domine infinitamente
                const current = prefs[key] || 0;
                prefs[key] = current + boost;
            }
        });

        localStorage.setItem('anime_prefs', JSON.stringify(prefs));
        localStorage.setItem('last_session_time', Date.now().toString());
    },

    // Cálculo de Jaccard Similarity para comparar animes entre sí
    calculateSimilarity(animeA, animeB) {
        if (!animeA.genres || !animeB.genres) return 0;
        const s1 = new Set(animeA.genres.map(g => g.toLowerCase()));
        const s2 = new Set(animeB.genres.map(g => g.toLowerCase()));
        const intersection = new Set([...s1].filter(x => s2.has(x)));
        const union = new Set([...s1, ...s2]);
        return (intersection.size / union.size);
    },

    scoreAnime(anime) {
        if (!anime || !anime.genres) return 0;
        const prefs = AppState.userPreferences;
        
        // 1. Alineación con el Perfil del Usuario
        let userScore = anime.genres.reduce((acc, g) => {
            const key = g.toLowerCase().trim();
            return acc + (prefs[key] || 0);
        }, 0);

        // 2. Bonus de Novedad (Favorece lo que no ha visto)
        const inHistory = AppState.history.some(h => h.id === anime.id);
        const noveltyBonus = inHistory ? 0 : 0.8;

        // 3. Serendipia Dinámica
        const serendipity = Math.random() * 0.3;

        return (userScore * (inHistory ? 0.3 : 1.0)) + noveltyBonus + serendipity;
    },

    getRanked(items, limit = 15) {
        return items
            .map(item => ({ item, score: this.scoreAnime(item) }))
            .sort((a, b) => b.score - a.score)
            .map(x => x.item)
            .slice(0, limit);
    },

    getSimilar(targetAnime, allItems, limit = 8) {
        if (!targetAnime || !allItems) return [];
        return allItems
            .filter(a => a.id !== targetAnime.id)
            .map(item => ({ 
                item, 
                sim: this.calculateSimilarity(targetAnime, item) + (this.scoreAnime(item) * 0.1) 
            }))
            .sort((a, b) => b.sim - a.sim)
            .map(x => x.item)
            .slice(0, limit);
    },

    getTopGenre() {
        const prefs = AppState.userPreferences;
        const entries = Object.entries(prefs);
        if (entries.length === 0) return null;
        return entries.sort((a, b) => b[1] - a[1])[0][0];
    },

    // Métodos de compatibilidad
    registerAnime(anime, weightValue) {
        if (weightValue > 1) this.track('play', anime);
        else this.track('view', anime);
    },
    registerFavorite(anime, isFav) {
        if (isFav) this.track('library', anime);
    },
    registerEpisodeWatch(anime) {
        this.track('finish', anime);
    }
};

// ==================== API ====================
const API = {
    requestCache: new Map(),
    
    async fetch(endpoint, params = {}) {
        try {
            const queryString = new URLSearchParams(params).toString();
            const url = `${API_BASE}/${endpoint}${queryString ? '?' + queryString : ''}`;
            
            if (params.nocache) {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            }

            if (this.requestCache.has(url)) {
                return this.requestCache.get(url);
            }
            
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            
            this.requestCache.set(url, data);
            setTimeout(() => this.requestCache.delete(url), 3 * 60 * 1000);
            
            return data;
        } catch (err) {
            console.error('[API Error]', err);
            return { success: false, error: err.message, data: null };
        }
    },

    getLatest(page = 1, nocache = false) {
        return this.fetch('latest', { page, nocache });
    },

    getTrending(nocache = false) {
        return this.fetch('trending', { nocache });
    },

    getGenre(genre, page = 1, nocache = false) {
        return this.fetch(`genre/${genre}`, { page, nocache });
    },

    search(query) {
        return this.fetch('search', { q: query });
    },

    getInfo(id) {
        const cleanId = id.replace('/anime/', '');
        return this.fetch(`info/${cleanId}`);
    },

    getVideo(id, cap) {
        const cleanId = id.replace('/anime/', '');
        return this.fetch(`video/${cleanId}/${cap}`);
    }
};

// ==================== UI BUILDER ====================
const UIBuilder = {
    buildCard(anime, isHistory = false) {
        const card = document.createElement('div');
        card.className = 'card';
        
        const epTag = anime.lastEpisode && anime.lastEpisode !== '?' 
            ? `<div class="ep-tag">EP ${anime.lastEpisode}</div>` 
            : '';
        
        const historyItem = AppState.history.find(h => h.id === anime.id);
        
        let progress = 0;
        if (historyItem) {
            if (historyItem.progressMap && historyItem.progressMap[historyItem.lastEp]) {
                progress = historyItem.progressMap[historyItem.lastEp];
            } else if (historyItem.progress !== undefined) {
                // Retrocompatibilidad
                progress = historyItem.progress;
            }
        }
        
        const progressHtml = (progress > 0) 
            ? `<div class="card-progress-container"><div class="card-progress-bar" style="width: ${Math.min(progress, 100)}%;"></div></div>` 
            : '';

        const coverUrl = anime.cover && anime.cover.length > 0 
            ? anime.cover 
            : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

        card.innerHTML = `
            <div class="card-img-wrapper">
                ${epTag}
                <img src="${coverUrl}" alt="${anime.title}" loading="lazy">
                ${progressHtml}
            </div>
            <div class="card-title">${anime.title}</div>
        `;
        
        const img = card.querySelector('img');
        img.addEventListener('load', () => img.classList.add('loaded'));
        img.addEventListener('error', () => {
            img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            img.classList.add('loaded');
        });
        
        card.addEventListener('click', () => {
            DetailOverlay.open(anime.id);
        });
        
        return card;
    },

    buildContinueCard(item) {
        const card = document.createElement('div');
        card.className = 'cw-card';

        const progress = item.progress && item.duration && item.duration > 0
            ? Math.min((item.progress / item.duration) * 100, 99)
            : 0;

        const progressHtml = progress > 0
            ? `<div class="cw-progress-bar" style="width:${progress}%;"></div>`
            : '';

        const epLabel = item.lastEp ? `EP ${item.lastEp}` : '';
        const epBadge = epLabel
            ? `<div class="cw-ep-badge">${epLabel}</div>`
            : '';

        const coverUrl = item.cover && item.cover.length > 0
            ? item.cover
            : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

        card.innerHTML = `
            <div class="cw-cover-wrap">
                ${epBadge}
                <img src="${coverUrl}" alt="${item.title}" loading="lazy">
                <div class="cw-play-icon">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="white" stroke="white" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </div>
                ${progressHtml}
            </div>
            <div class="cw-info">
                <div class="cw-name">${item.title}</div>
            </div>
        `;

        const img = card.querySelector('img');
        img.addEventListener('load', () => img.classList.add('loaded'));
        img.addEventListener('error', () => {
            img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            img.classList.add('loaded');
        });

        card.addEventListener('click', () => {
            DetailOverlay.open(item.id);
        });

        return card;
    },

    renderHistorySection() {
        const container = $('continue-watching-container');
        if (!container) return;
        if (AppState.history.length === 0) {
            container.innerHTML = '';
            return;
        }

        const section = document.createElement('div');
        section.className = 'continue-watching-section';
        section.innerHTML = `
            <div class="cw-header">
                <span class="cw-title">Seguir Viendo</span>
                <button class="cw-see-all">Ver todo</button>
            </div>
            <div class="cw-row" id="history-row"></div>
        `;

        const row = section.querySelector('#history-row');
        AppState.history.slice(0, 10).forEach((item, idx) => {
            const card = this.buildContinueCard(item);
            card.style.animationDelay = `${idx * 0.04}s`;
            row.appendChild(card);
        });

        section.querySelector('.cw-see-all').addEventListener('click', () => {
            Navigation.switchView('view-library');
        });

        container.innerHTML = '';
        container.appendChild(section);
    }
};

// ==================== HOME MANAGER ====================
const HomeManager = {
    async initializeSections(forceRefresh = false) {
        const content = $('home-content');
        if (forceRefresh) {
            content.innerHTML = '';
            AppState.homeSections.clear();
            AppState.homeInitialized = false;
            AppState.seenAnimeIds.clear();
            API.requestCache.clear();
            
            const topGenre = Recommendations.getTopGenre();
            const recCont = $('recommendations-container');
            if (topGenre && recCont) {
                const recConfig = { id: 'for_you', title: 'Recomendado Para Ti', type: 'genre', endpoint: `genre/${topGenre}` };
                recCont.innerHTML = '';
                const sec = this.createSectionElement(recConfig);
                recCont.appendChild(sec);
                AppState.homeSections.set(recConfig.id, { config: recConfig, element: sec, loaded: false, data: [] });
            }
        }

        if (AppState.homeInitialized) return;
        
        for (const config of SECTIONS_CONFIG) {
            const section = this.createSectionElement(config);
            content.appendChild(section);
            AppState.homeSections.set(config.id, {
                config,
                element: section,
                loaded: false,
                data: [],
                displayedCount: 0
            });
            AppState.sectionPageCache.set(config.id, forceRefresh ? Math.floor(Math.random() * 3) + 1 : 1);
        }
        
        AppState.homeInitialized = true;
        this.setupIntersectionObserver();
        await this.loadInitialSections(forceRefresh);
    },

    forceRefresh() {
        showToast('Actualizando catálogo...');
        const loader = $('home-loader');
        if (loader) loader.style.display = 'flex';
        this.initializeSections(true);
    },

    createSectionElement(config) {
        const section = document.createElement('div');
        section.className = 'home-section';
        section.id = `section-${config.id}`;
        section.innerHTML = `
            <div class="home-section-header">
                <h2 class="home-section-title">${config.title}</h2>
                <button class="btn-see-more">Ver más</button>
            </div>
            <div class="row-scroll" id="row-${config.id}"></div>
        `;
        
        const btn = section.querySelector('.btn-see-more');
        btn.addEventListener('click', () => {
            CategoryManager.open(config);
        });
        
        return section;
    },

    setupIntersectionObserver() {
        const rootEl = $('home-scroll');
        const sentinel = $('home-sentinel');

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !AppState.homeLoading) {
                    this.loadNextSections();
                }
            });
        }, { 
            root: rootEl,
            rootMargin: '300px 0px 300px 0px'
        });

        if (sentinel) {
            observer.observe(sentinel);
        }
    },

    async loadInitialSections(nocache = false) {
        const unloaded = Array.from(AppState.homeSections.values())
            .filter(s => !s.loaded)
            .slice(0, 3);
        
        if (unloaded.length === 0) {
            const loader = $('home-loader');
            if (loader) loader.style.display = 'none';
            return;
        }
        
        AppState.homeLoading = true;
        const promises = unloaded.map(section => this.loadSection(section.config.id, nocache));
        await Promise.allSettled(promises);
        
        const loader = $('home-loader');
        if (loader) loader.style.display = 'none';
        AppState.homeLoading = false;
    },

    async loadNextSections() {
        const unloaded = Array.from(AppState.homeSections.values())
            .filter(s => !s.loaded);
        
        if (unloaded.length === 0) {
            const loader = $('home-loader');
            if (loader) loader.style.display = 'none';
            return;
        }
        
        AppState.homeLoading = true;
        const batchSize = 2;
        const batch = unloaded.slice(0, batchSize);
        const promises = batch.map(section => this.loadSection(section.config.id));
        
        await Promise.allSettled(promises);
        AppState.homeLoading = false;
    },

    async loadSection(sectionId, nocache = false) {
        const section = AppState.homeSections.get(sectionId);
        if (!section) return;

        if (AppState.sectionsLoading.has(sectionId)) return;
        AppState.sectionsLoading.add(sectionId);

        try {
            const { config } = section;
            let data;
            
            if (config.type === 'latest') {
                const page = AppState.sectionPageCache.get(sectionId) || 1;
                data = await API.getLatest(page, nocache);
                AppState.sectionPageCache.set(sectionId, (page % 5) + 1);
            } else if (config.type === 'trending') {
                data = await API.getTrending(nocache);
            } else if (config.type === 'genre') {
                const genre = config.endpoint.split('/')[1];
                const page = AppState.sectionPageCache.get(sectionId) || 1;
                data = await API.getGenre(genre, page, nocache);
                AppState.sectionPageCache.set(sectionId, (page % 3) + 1);
            }

            section.loaded = true;

            if (data && data.success && data.data && data.data.length > 0) {
                // Add to AI Catalog
                AIManager.addToCatalog(data.data);
                
                let displayData = nocache ? shuffleArray([...data.data]) : data.data;
                
                section.data = displayData;
                const row = $(`row-${sectionId}`);
                if (row) {
                    row.innerHTML = '';
                    const filteredItems = [];
                    for (const item of displayData) {
                        if (!AppState.seenAnimeIds.has(item.id) && filteredItems.length < 15) {
                            AppState.seenAnimeIds.add(item.id);
                            filteredItems.push(item);
                        }
                    }
                    
                    filteredItems.forEach((item, idx) => {
                        const card = UIBuilder.buildCard(item);
                        card.style.animationDelay = `${idx * 0.05}s`;
                        row.appendChild(card);
                    });
                }
            } else {
                if (section.element) section.element.style.display = 'none';
            }
        } catch (err) {
            console.error('[HomeManager] Error cargando sección:', err);
            section.loaded = true;
            if (section.element) section.element.style.display = 'none';
        } finally {
            AppState.sectionsLoading.delete(sectionId);
        }
    },

    getPersonalizedItems() {
        const items = [];
        AppState.homeSections.forEach(s => items.push(...s.data));
        return items;
    },

    renderPersonalizedSection() {
        const container = $('recommendations-container');
        if (!container) return;
        
        // Obtenemos una muestra de todos los animes cargados en el Home
        const allItems = [];
        const seen = new Set();
        
        AppState.homeSections.forEach(section => {
            if (section.data) {
                section.data.forEach(item => {
                    if (!seen.has(item.id)) {
                        allItems.push(item);
                        seen.add(item.id);
                    }
                });
            }
        });

        if (allItems.length === 0) return;

        // El motor de recomendaciones clasifica dinámicamente según el perfil del usuario
        const personalizedItems = Recommendations.getRanked(allItems, 10);

        const section = document.createElement('div');
        section.className = 'home-section recommendation-panel';
        section.innerHTML = `
            <div class="home-section-header">
                <div class="section-title-block">
                    <h2 class="home-section-title">Algoritmo SAO: Para ti</h2>
                    <span class="section-subtitle">Ajustado a tus gustos dinámicos</span>
                </div>
                <button class="btn-refresh-icon" id="btn-refresh-home" title="Actualizar">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                </button>
            </div>
            <div class="row-scroll" id="personalized-row"></div>
        `;

        const row = section.querySelector('#personalized-row');
        personalizedItems.forEach((item, idx) => {
            const card = UIBuilder.buildCard(item);
            card.style.animationDelay = `${idx * 0.04}s`;
            row.appendChild(card);
        });

        section.querySelector('#btn-refresh-home').addEventListener('click', () => {
            HomeManager.forceRefresh();
        });

        container.innerHTML = '';
        container.appendChild(section);
    },

    bindFilterChips() {
        document.querySelectorAll('[data-home-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-home-filter]').forEach(n => n.classList.remove('active'));
                btn.classList.add('active');
                const filter = btn.dataset.homeFilter;
                if (filter === 'recommended') {
                    $('recommendations-container')?.scrollIntoView({ behavior: 'smooth' });
                } else {
                    $(`section-${filter}`)?.scrollIntoView({ behavior: 'smooth' });
                }
            });
        });
    }
};

// ==================== CATEGORY MANAGER ====================
const CategoryManager = {
    open(config) {
        AppState.categoryType = config.type;
        AppState.categoryGenre = config.type === 'genre' ? config.endpoint.split('/')[1] : null;
        AppState.categoryPage = 1;
        AppState.categoryHasMore = true;

        $('category-title').textContent = config.title;
        $('category-grid').innerHTML = '';
        
        Navigation.switchView('view-category');
        this.loadMore();
    },

    async loadMore() {
        if (AppState.categoryLoading || !AppState.categoryHasMore) return;
        
        AppState.categoryLoading = true;
        const loader = $('category-loader');
        if (loader) loader.style.display = 'flex';

        try {
            let data;
            if (AppState.categoryType === 'latest') {
                data = await API.getLatest(AppState.categoryPage);
            } else if (AppState.categoryType === 'trending') {
                data = await API.getTrending();
                AppState.categoryHasMore = false;
            } else if (AppState.categoryType === 'genre' && AppState.categoryGenre) {
                data = await API.getGenre(AppState.categoryGenre, AppState.categoryPage);
            } else {
                data = { success: false, data: [] };
            }

            if (data.success && data.data && data.data.length > 0) {
                // Add to AI Catalog
                AIManager.addToCatalog(data.data);
                
                const grid = $('category-grid');
                data.data.forEach((item, idx) => {
                    const card = UIBuilder.buildCard(item);
                    card.style.animationDelay = `${(idx % 20) * 0.05}s`;
                    grid.appendChild(card);
                });
                
                AppState.categoryPage++;
                if (data.data.length < 20) {
                    AppState.categoryHasMore = false;
                }
            } else {
                AppState.categoryHasMore = false;
            }
        } catch (err) {
            console.error('[CategoryManager] Error cargando más:', err);
            showToast('Error al cargar más');
            AppState.categoryHasMore = false;
        } finally {
            AppState.categoryLoading = false;
            if (loader) {
                loader.style.display = AppState.categoryHasMore ? 'flex' : 'none';
            }
        }
    },

    setupScroll() {
        const scrollEl = $('category-scroll');
        const sentinel = $('category-sentinel');
        
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !AppState.categoryLoading && AppState.categoryHasMore) {
                    this.loadMore();
                }
            });
        }, { root: scrollEl, rootMargin: '0px 0px 300px 0px' });
        
        if (sentinel) {
            observer.observe(sentinel);
        }
    }
};

// ==================== DETAIL OVERLAY ====================
const DetailOverlay = {
    setup() {
        const btnSort = $('btn-sort-ep');
        if (btnSort) {
            btnSort.onclick = () => {
                AppState.episodeSortOrder *= -1;
                btnSort.classList.toggle('active', AppState.episodeSortOrder === -1);
                this.renderEpisodeGrid();
            };
        }
    },

    resetVisuals() {
        const titleEl = $('detail-title');
        const coverEl = $('detail-cover');
        const backdropEl = $('detail-backdrop-fixed');
        const synopsisEl = $('detail-synopsis');
        const statusEl = $('detail-status');
        const epCountEl = $('detail-ep-count');
        const genresCont = $('detail-genres');
        const episodesCont = $('detail-episodes');
        const rangesCont = $('ep-ranges-container');

        if(titleEl) titleEl.textContent = 'Cargando...';
        if(coverEl) coverEl.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        if(backdropEl) backdropEl.style.backgroundImage = 'none';
        if(synopsisEl) synopsisEl.textContent = '';
        if(statusEl) statusEl.textContent = '...';
        if(epCountEl) epCountEl.textContent = '0';
        if(genresCont) genresCont.innerHTML = '';
        if(episodesCont) episodesCont.innerHTML = '';
        if(rangesCont) rangesCont.innerHTML = '';
        
        const btn = $('btn-library');
        if(btn) btn.classList.remove('active');

        const btnSort = $('btn-sort-ep');
        if(btnSort) btnSort.classList.remove('active');
        
        AppState.episodeSortOrder = 1;
        AppState.currentEpisodePage = 0;
    },

    async open(animeId) {
        const overlay = $('overlay-detail');
        overlay.classList.add('active');
        
        this.resetVisuals();

        const loading = $('detail-loading');
        const loaded = $('detail-loaded');
        if (loading) loading.style.display = 'flex';
        if (loaded) {
            loaded.style.display = 'none';
            loaded.style.opacity = '0';
        }

        try {
            const data = await API.getInfo(animeId);
            if (!data.success || !data.data) {
                throw new Error(data.error || 'No se encontró el anime');
            }

            const anime = data.data;
            AppState.currentAnime = anime;
            
            Recommendations.track('view', anime);

            if (loading) loading.style.display = 'none';
            if (loaded) {
                loaded.style.display = 'block';
                loaded.style.opacity = '1';
            }
            this.render(anime);
        } catch (err) {
            console.error('[DetailOverlay] Error:', err);
            showToast('Anime no encontrado');
            this.close();
        }
    },

    render(anime) {
        const titleEl = $('detail-title');
        const coverEl = $('detail-cover');
        const backdropEl = $('detail-backdrop-fixed');
        const synopsisEl = $('detail-synopsis');
        const statusEl = $('detail-status');
        const epCountEl = $('detail-ep-count');

        if (titleEl) titleEl.textContent = anime.title || 'Animé';
        if (coverEl) {
            coverEl.src = anime.cover || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        }
        if (backdropEl) {
            backdropEl.style.backgroundImage = anime.cover ? `url(${anime.cover})` : 'none';
        }
        if (synopsisEl) synopsisEl.textContent = anime.synopsis || 'Sin sinopsis disponible';
        if (statusEl) statusEl.textContent = anime.status || 'Desconocido';
        if (epCountEl) epCountEl.textContent = (anime.episodes && anime.episodes.length) ? anime.episodes.length : 0;

        const genresCont = $('detail-genres');
        if (genresCont) {
            genresCont.innerHTML = '';
            (anime.genres || []).forEach((g, idx) => {
                const span = document.createElement('span');
                span.textContent = g;
                span.style.animationDelay = `${idx * 0.05}s`;
                genresCont.appendChild(span);
            });
        }

        AppState.currentEpisodePage = 0;
        this.renderEpisodeRanges(anime);
        this.renderEpisodeGrid();

        this.updateLibraryBtn();
        this.renderSimilar(anime);
    },

    renderEpisodeRanges(anime) {
        const container = $('ep-ranges-container');
        if (!container) return;
        container.innerHTML = '';

        // IMPORTANTE: Ordenar episodios numéricamente antes de calcular rangos
        const eps = [...(anime.episodes || [])].sort((a, b) => Number(a.number) - Number(b.number));
        
        if (eps.length <= AppState.episodePageSize) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        const pageCount = Math.ceil(eps.length / AppState.episodePageSize);

        for (let i = 0; i < pageCount; i++) {
            // Calculamos el número real de los capítulos basándonos en la lista ordenada
            const startEp = eps[i * AppState.episodePageSize].number;
            const lastIdx = Math.min((i + 1) * AppState.episodePageSize - 1, eps.length - 1);
            const endEp = eps[lastIdx].number;
            
            const chip = document.createElement('button');
            chip.className = `ep-range-chip ${i === AppState.currentEpisodePage ? 'active' : ''}`;
            chip.textContent = `${startEp}-${endEp}`;
            chip.onclick = () => {
                if (AppState.currentEpisodePage === i) return;
                AppState.currentEpisodePage = i;
                container.querySelectorAll('.ep-range-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this.renderEpisodeGrid();
            };
            container.appendChild(chip);
        }
    },

    renderEpisodeGrid() {
        const episodesCont = $('detail-episodes');
        const anime = AppState.currentAnime;
        if (!episodesCont || !anime) return;

        episodesCont.innerHTML = '';
        
        const rawEps = anime.episodes || [];
        if (rawEps.length === 0) {
            const msg = document.createElement('div');
            msg.className = 'empty-state-premium';
            msg.textContent = 'No se encontraron episodios.';
            episodesCont.appendChild(msg);
            return;
        }

        // 1. Siempre ordenar de forma ascendente primero para que los rangos sean consistentes
        let sortedEps = [...rawEps].sort((a, b) => Number(a.number) - Number(b.number));

        // 2. Aplicar paginación sobre la lista ordenada
        const start = AppState.currentEpisodePage * AppState.episodePageSize;
        let displayEps = sortedEps.slice(start, start + AppState.episodePageSize);

        // 3. Aplicar orden visual del usuario (Invertir si es DESC)
        if (AppState.episodeSortOrder === -1) {
            displayEps.reverse();
        }

        displayEps.forEach((ep, idx) => {
            const row = document.createElement('div');
            row.className = 'ep-row';
            row.style.animationDelay = `${idx * 0.02}s`;
            
            const historyItem = AppState.history.find(h => h.id === anime.id);
            const isWatched = historyItem && historyItem.watched && historyItem.watched.includes(ep.number);
            const epProgress = (historyItem && historyItem.progressMap) ? (historyItem.progressMap[ep.number] || 0) : 0;
            
            const watchTag = isWatched && epProgress >= 90 
                ? '<span class="ep-status-tag watched">Visto</span>' 
                : (epProgress > 0 ? `<span class="ep-status-tag">En curso ${Math.round(epProgress)}%</span>` : '');

            row.innerHTML = `
                <div class="ep-row-content">
                    <span class="ep-number" style="font-weight: 600;">Episodio ${ep.number}</span>
                    ${watchTag}
                </div>
                <div class="ep-row-icon">
                   <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>
                </div>
            `;
            row.onclick = () => {
                PlayerOverlay.open(ep.number);
            };
            episodesCont.appendChild(row);
        });
    },

    renderSimilar(anime) {
        const parent = $('detail-loaded');
        if (!parent) return;

        // Limpiar sección anterior si existe
        const existingRec = parent.querySelector('.similar-section');
        if (existingRec) existingRec.remove();

        const allLoaded = [];
        AppState.homeSections.forEach(s => allLoaded.push(...s.data));
        
        const similar = Recommendations.getSimilar(anime, allLoaded, 8);
        if (similar.length === 0) return;

        const container = document.createElement('div');
        container.className = 'similar-section';
        container.innerHTML = `
            <div class="similar-header" style="margin: 20px 0 12px; padding: 0 4px;">
                <h3 style="font-size: 1.1rem; font-weight: 700; color: #fff;">Animes Similares</h3>
                <p style="font-size: 0.8rem; color: var(--text-soft); margin-top: 2px;">Para expandir tus gustos</p>
            </div>
            <div class="row-scroll" id="similar-row"></div>
        `;

        const row = container.querySelector('#similar-row');
        similar.forEach((item, idx) => {
            const card = UIBuilder.buildCard(item);
            card.style.animationDelay = `${idx * 0.05}s`;
            row.appendChild(card);
        });

        parent.appendChild(container);
    },

    updateLibraryBtn() {
        const btn = $('btn-library');
        if(!AppState.currentAnime || !btn) return;
        const isSaved = AppState.library.some(a => a.id === AppState.currentAnime.id);
        
        if (isSaved) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    },

    close() {
        const overlay = $('overlay-detail');
        if (overlay) overlay.classList.remove('active');
    }
};

// ==================== PLAYER OVERLAY ====================
const PlayerOverlay = {
    retryCount: 0,
    maxRetries: 3,
    
    async open(epNumber) {
        if (!AppState.currentAnime) return;
        
        AppState.currentEpisode = epNumber;
        AppState.currentServerIndex = 0;
        this.retryCount = 0;
        
        const overlay = $('overlay-player');
        if (overlay) {
            overlay.classList.add('active');
            document.body.classList.add('player-active');
        }
        
        const titleEl = $('player-title');
        const episodeEl = $('player-episode-info');
        const iframeEl = $('player-iframe');
        
        if (titleEl) titleEl.textContent = AppState.currentAnime.title;
        if (episodeEl) episodeEl.textContent = `Episodio ${epNumber}`;
        if (iframeEl) iframeEl.src = '';
        
        const loader = $('player-loader');
        if (loader) loader.style.display = 'flex';
        
        const error = $('player-error');
        if (error) error.classList.add('hidden');
        
        const serverSelector = $('server-selector');
        if (serverSelector) serverSelector.innerHTML = '';

        try {
            const data = await API.getVideo(AppState.currentAnime.id, epNumber);
            
            if (!data.success || !data.data || !data.data.servers || data.data.servers.length === 0) {
                throw new Error('No se encontraron servidores');
            }

            AppState.currentServers = data.data.servers;
            this.renderServers();
            this.loadServer(0);
            this.updateNavigation();
        } catch (err) {
            console.error('[PlayerOverlay] Error:', err);
            this.showError('No se pudo cargar el video');
            this.updateNavigation();
        }
    },

    renderServers() {
        const selector = $('server-selector');
        if (!selector) return;
        
        selector.innerHTML = '';
        AppState.currentServers.forEach((server, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = `${server.name || `Servidor ${idx + 1}`}`;
            selector.appendChild(opt);
        });
        selector.addEventListener('change', (e) => {
            this.loadServer(parseInt(e.target.value, 10));
        });
    },

    progressTimer: null,
    
    startProgressTracking() {
        if (this.progressTimer) clearInterval(this.progressTimer);
        
        let progress = 0;
        const historyItem = AppState.history.find(h => h.id === AppState.currentAnime.id);
        if (historyItem && historyItem.progressMap && historyItem.progressMap[AppState.currentEpisode]) {
            progress = historyItem.progressMap[AppState.currentEpisode];
        }

        this.progressTimer = setInterval(() => {
            if (progress < 98) {
                // Supongamos un episodio de 24 mins (1440s)
                // Cada 10s sumamos ~0.7%
                progress += 0.7;
                this.saveToHistory(AppState.currentAnime, AppState.currentEpisode, progress);
            } else if (progress >= 98 && progress < 100) {
                progress = 100;
                this.saveToHistory(AppState.currentAnime, AppState.currentEpisode, 100);
            }
        }, 10000);
    },

    loadServer(index) {
        const server = AppState.currentServers[index];
        if (!server) return;
        
        AppState.currentServerIndex = index;
        const loader = $('player-loader');
        const error = $('player-error');
        
        if (loader) loader.style.display = 'none';
        if (error) error.classList.add('hidden');
        
        const iframe = $('player-iframe');
        if (!iframe) return;

        iframe.onload = () => {
            if (AppState.currentAnime && AppState.currentEpisode) {
                this.saveToHistory(AppState.currentAnime, AppState.currentEpisode);
                this.startProgressTracking();
            }
        };
        
        iframe.onerror = () => {
            if (this.retryCount < this.maxRetries - 1) {
                this.retryCount++;
                setTimeout(() => {
                    this.loadServer(AppState.currentServerIndex);
                }, 1000);
            } else {
                this.showError('Servidor no disponible. Intenta otro.');
            }
        };
        
        iframe.src = server.url;
    },

    showError(message) {
        const loader = $('player-loader');
        const error = $('player-error');
        
        if (loader) loader.style.display = 'none';
        if (error) {
            error.classList.remove('hidden');
            const msgEl = error.querySelector('.error-message');
            if (msgEl) msgEl.textContent = message;
        }
        
        const btnRetry = $('btn-retry');
        if (btnRetry) {
            btnRetry.onclick = () => {
                this.retryCount = 0;
                this.loadServer(AppState.currentServerIndex);
            };
        }
    },

    updateNavigation() {
        const eps = AppState.currentAnime?.episodes || [];
        const canGoPrev = eps.some(e => e.number === AppState.currentEpisode - 1);
        const canGoNext = eps.some(e => e.number === AppState.currentEpisode + 1);

        const btnPrev = $('btn-prev-ep');
        const btnNext = $('btn-next-ep');
        
        if (btnPrev) {
            btnPrev.disabled = !canGoPrev;
            btnPrev.onclick = () => {
                if (canGoPrev) this.open(AppState.currentEpisode - 1);
            };
        }
        if (btnNext) {
            btnNext.disabled = !canGoNext;
            btnNext.onclick = () => {
                if (canGoNext) this.open(AppState.currentEpisode + 1);
            };
        }
    },

    saveToHistory(anime, episode, progress = 0) {
        const now = Date.now();
        const existingIndex = AppState.history.findIndex(h => h.id === anime.id);
        
        let historyItem;
        if (existingIndex > -1) {
            // Preservar datos existentes (como episodios ya vistos)
            historyItem = AppState.history[existingIndex];
            historyItem.lastEp = episode;
            historyItem.lastUpdated = now;
            historyItem.timestamp = now; // Mover al principio
            
            if (!historyItem.watched) historyItem.watched = [];
            if (!historyItem.watched.includes(episode)) {
                historyItem.watched.push(episode);
            }
            
            if (!historyItem.progressMap) historyItem.progressMap = {};
            // Solo actualizamos si el progreso es mayor o si es un episodio nuevo
            if (progress > (historyItem.progressMap[episode] || 0)) {
                historyItem.progressMap[episode] = progress;
            }
            
            AppState.history.splice(existingIndex, 1);
        } else {
            historyItem = {
                id: anime.id,
                title: anime.title,
                cover: anime.cover,
                lastEp: episode,
                watched: [episode],
                progressMap: { [episode]: progress },
                timestamp: now,
                lastUpdated: now
            };
        }
        
        AppState.history.unshift(historyItem);
        AppState.history = AppState.history.slice(0, 100);
        
        localStorage.setItem('anime_history', JSON.stringify(AppState.history));
        UIBuilder.renderHistorySection();
        Recommendations.registerEpisodeWatch(anime);
    },
    
    updateActiveProgress(percent) {
        if (!AppState.currentAnime || !AppState.currentEpisode) return;
        this.saveToHistory(AppState.currentAnime, AppState.currentEpisode, percent);
    },

    close() {
        const overlay = $('overlay-player');
        const iframe = $('player-iframe');
        
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }

        if (overlay) {
            overlay.classList.remove('active');
            document.body.classList.remove('player-active');
        }
        if (iframe) iframe.src = '';
        
        if (document.fullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen();
        }
    }
};

// ==================== SEARCH ====================
const Search = {
    reset() {
        const input = $('search-input');
        const grid = $('search-grid');
        const message = $('search-message');
        const clear = $('search-clear');
        
        if (input) input.value = '';
        if (clear) clear.classList.add('hidden');
        if (grid) grid.innerHTML = '';
        if (message) {
            message.style.display = 'flex';
            message.style.animation = 'fadeInUp 0.5s ease-out forwards';
        }
        this.renderDiscoverGenres();
    },

    setup() {
        const input = $('search-input');
        const clear = $('search-clear');
        const message = $('search-message');
        const grid = $('search-grid');
        const suggestionsBox = $('search-suggestions');

        if (!input) return;

        // Mostrar géneros al inicio
        this.renderDiscoverGenres();

        input.addEventListener('input', debounce(async (e) => {
            const q = e.target.value.trim();
            
            if (clear) clear.classList.toggle('hidden', q.length === 0);

            if (q.length < 2) {
                if (suggestionsBox) suggestionsBox.classList.add('hidden');
                if (q.length === 0) {
                    if (grid) grid.innerHTML = '';
                    if (message) {
                        message.style.display = 'flex';
                        this.renderDiscoverGenres();
                    }
                }
                return;
            }

            this.showSuggestions(q);
        }, 300));

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const q = input.value.trim();
                if (q.length >= 2) {
                    if (suggestionsBox) suggestionsBox.classList.add('hidden');
                    this.execute(q);
                }
            }
        });

        document.addEventListener('click', (e) => {
            if (suggestionsBox && !suggestionsBox.contains(e.target) && e.target !== input) {
                suggestionsBox.classList.add('hidden');
            }
        });

        if (clear) {
            clear.addEventListener('click', () => {
                input.value = '';
                if (grid) grid.innerHTML = '';
                clear.classList.add('hidden');
                if (message) {
                    message.style.display = 'flex';
                    this.renderDiscoverGenres();
                }
                if (suggestionsBox) suggestionsBox.classList.add('hidden');
            });
        }
    },

    renderDiscoverGenres() {
        const container = $('discover-genres');
        if (!container) return;

        const relevantGenres = [
            'Películas', 'Acción', 'Aventuras', 'Ciencia Ficción', 'Comedia', 
            'Deportes', 'Drama', 'Fantasía', 'Magia', 
            'Misterio', 'Psicológico', 'Romance', 'Shounen', 
            'Seinen', 'Terror', 'Sobrenatural'
        ];

        container.innerHTML = '';
        relevantGenres.forEach((genre, idx) => {
            const chip = document.createElement('div');
            chip.className = 'genre-chip';
            chip.textContent = genre;
            chip.setAttribute('data-genre', genre);
            chip.style.animation = `fadeInUp 0.4s ease-out forwards`;
            chip.style.animationDelay = `${idx * 0.04}s`;
            chip.onclick = (e) => {
                e.stopPropagation();
                this.execute(genre, { isGenre: true });
            };
            container.appendChild(chip);
        });
    },

    async showSuggestions(query) {
        const suggestionsBox = $('search-suggestions');
        if (!suggestionsBox) return;

        try {
            const data = await API.search(query);
            if (data.success && data.data && data.data.length > 0) {
                const limited = data.data.slice(0, 6);
                suggestionsBox.innerHTML = '';
                limited.forEach(anime => {
                    const item = document.createElement('div');
                    item.className = 'suggestion-item';
                    item.innerHTML = `
                        <img src="${anime.cover}" class="suggestion-cover" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='">
                        <div class="suggestion-info">
                            <span class="suggestion-title">${anime.title}</span>
                            <span class="suggestion-meta">${anime.status || 'Anime'}</span>
                        </div>
                    `;
                    item.addEventListener('click', () => {
                        suggestionsBox.classList.add('hidden');
                        const input = $('search-input');
                        if (input) input.value = anime.title;
                        DetailOverlay.open(anime.id);
                    });
                    suggestionsBox.appendChild(item);
                });
                suggestionsBox.classList.remove('hidden');
            } else {
                suggestionsBox.classList.add('hidden');
            }
        } catch (err) {
            console.error('[Search] Suggestion Error:', err);
            suggestionsBox.classList.add('hidden');
        }
    },

    async execute(query, options = {}) {
        const message = $('search-message');
        const grid = $('search-grid');
        const loader = $('search-loader');
        const suggestionsBox = $('search-suggestions');
        const input = $('search-input');

        if (suggestionsBox) suggestionsBox.classList.add('hidden');
        if (message) message.style.display = 'none';
        
        // Limpiamos resultados previos
        if (grid) grid.innerHTML = '';
        if (loader) loader.classList.remove('hidden');

        // Si es búsqueda por género, podemos limpiar el input o dejarlo
        if (options.isGenre && input) {
            input.value = '';
            const clear = $('search-clear');
            if (clear) clear.classList.add('hidden');
        }

        try {
            let data;
            if (options.isGenre) {
                // Mapeo de nombres a slugs específicos de la API
                const genreMappings = {
                    'peliculas': 'pelicula',
                    'aventuras': 'aventura',
                    'ciencia-ficcion': 'ciencia-ficcion',
                    'recuentos-de-la-vida': 'recuentos-de-la-vida',
                    'lovecraft': 'lovecraft'
                };

                let genreSlug = query.toLowerCase()
                    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar acentos
                    .replace(/\s+/g, '-'); // Espacios por guiones
                
                // Aplicar mapeo manual si existe
                if (genreMappings[genreSlug]) {
                    genreSlug = genreMappings[genreSlug];
                }
                
                // Si es películas, intentamos una búsqueda más amplia o filtrada
                if (query === 'Películas') {
                    // Primero intentamos con "movie" que suele ser más efectivo
                    data = await API.search('movie'); 
                    
                    // Si hay pocos resultados, intentamos con "pelicula"
                    if (!data.success || !data.data || data.data.length < 5) {
                        const fallbackData = await API.search('pelicula');
                        if (fallbackData.success && fallbackData.data.length > 0) {
                            if (!data.data) data.data = [];
                            // Combinamos y evitamos duplicados
                            const existingIds = new Set(data.data.map(i => i.id));
                            fallbackData.data.forEach(item => {
                                if (!existingIds.has(item.id)) data.data.push(item);
                            });
                            data.success = true;
                        }
                    }

                    // Filtramos por episodios (1) o tipo
                    if (data.success && data.data) {
                        data.data = data.data.filter(anime => {
                            return anime.episodes === 1 || 
                                   (anime.type && anime.type.toLowerCase().includes('movie')) ||
                                   (anime.title && anime.title.toLowerCase().includes('movie'));
                        });
                    }
                } else {
                    data = await API.getGenre(genreSlug);
                }
            } else {
                data = await API.search(query);
            }

            if (loader) loader.classList.add('hidden');
            
            if (!data.success || !data.data || data.data.length === 0) {
                if (message) {
                    const p = message.querySelector('p');
                    if (p) p.textContent = 'No se encontraron resultados para "' + query + '"';
                    message.style.display = 'flex';
                    this.renderDiscoverGenres();
                }
            } else {
                // Add to AI Catalog
                AIManager.addToCatalog(data.data);
                
                if (grid) {
                    grid.innerHTML = '';
                    
                    if (options.isGenre) {
                        const header = document.createElement('div');
                        header.className = 'genre-results-header';
                        header.innerHTML = `
                            <div class="genre-header-info">
                                <div class="genre-tag-active">
                                    <span style="color: var(--text-secondary); font-size: 14px; display: block; margin-bottom: 4px; font-weight: 500;">Búsqueda por género</span>
                                    ${query}
                                </div>
                                <div class="genre-results-count">${data.data.length} Animes</div>
                            </div>
                            <button class="btn-genre-reset">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                                Volver al explorador
                            </button>
                        `;
                        header.querySelector('.btn-genre-reset').onclick = () => {
                            grid.innerHTML = '';
                            message.style.display = 'flex';
                            message.style.animation = 'fadeInUp 0.4s ease-out';
                            this.renderDiscoverGenres();
                        };
                        grid.appendChild(header);
                    }

                    data.data.forEach((item, idx) => {
                        const card = UIBuilder.buildCard(item);
                        card.style.animationDelay = `${idx * 0.05}s`;
                        grid.appendChild(card);
                    });
                }
            }
        } catch (err) {
            console.error('[Search] Error:', err);
            if (loader) loader.classList.add('hidden');
            showToast('Error en la búsqueda');
        }
    }
};

// ==================== AI MANAGER ====================
const AIManager = {
    async init() {
        if (!AppState.apiKey || AppState.apiKey.length < 10) {
            this.updateStatus('offline', 'Gemini Offline');
            return;
        }

        try {
            AppState.aiInstance = new GoogleGenAI({ apiKey: AppState.apiKey });
            this.updateStatus('online', 'Gemini Online');
        } catch (err) {
            console.error('[AI Init Error]', err);
            this.updateStatus('offline', 'Error de Conexión');
        }
    },

    getSystemPrompt() {
        return `Eres el asistente de AnimeSAO Pro. Tu misión es recomendar animes que el usuario pueda ver.
        
        REGLAS DE ORO:
        1. Analiza los gustos del usuario (basándote en lo que pregunta).
        2. Si vas a recomendar un anime, cítalo al final así: [TRIGGER: Nombre del Anime]
        3. Solo un TRIGGER por respuesta.
        4. El nombre en el TRIGGER debe ser el oficial para que mi buscador lo encuentre.
        5. Mantén un tono entusiasta pero profesional.
        
        Catálogo parcial de referencia: ${AppState.catalogIndex.slice(0, 30).join(', ')}.`;
    },

    updateStatus(status, text) {
        const dot = document.querySelector('.status-dot');
        const label = $('ai-status-text');
        if (dot) {
            dot.classList.toggle('online', status === 'online');
        }
        if (label) label.textContent = text;
    },

    addToCatalog(items) {
        if (!items || !Array.isArray(items)) return;
        items.forEach(item => {
            if (item.title && !AppState.catalogIndex.includes(item.title)) {
                AppState.catalogIndex.push(item.title);
                if (AppState.catalogIndex.length > 300) AppState.catalogIndex.shift();
            }
        });
    },

    async sendMessage(text) {
        if (!AppState.aiInstance) {
            await this.init();
            if (!AppState.aiInstance) return;
        }

        // We explicitly don't push to aiMessages yet because we want to pass the new message
        // via the sendMessage method of the chat session, while history contains everything else.
        this.setLoading(true);

        try {
            console.log(`[AI Flow] Preparando envío: "${text.substring(0, 30)}..."`);
            
            // Re-creating the chat session with the previous history to ensure it's always up to date
            // Note: role 'model' is used for AI responses in the SDK
            const history = AppState.aiMessages.map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.text }]
            }));

            const chat = AppState.aiInstance.chats.create({
                model: "gemini-1.5-flash", // We use a very stable model to avoid name-based errors if 2.5/2.0 is not recognized
                config: {
                    systemInstruction: this.getSystemPrompt()
                },
                history: history.filter(h => h.parts && h.parts[0] && h.parts[0].text && h.parts[0].text.trim().length > 0)
            });

            // Agregamos el mensaje a la UI antes de recibir respuesta (solo si tiene texto)
            if (!text || text.trim().length === 0) return;
            this.addMessage('user', text);

            const result = await chat.sendMessage({ message: text });
            const aiText = result.text;
            
            if (!aiText) throw new Error('La IA retornó una respuesta vacía');
            
            this.addMessage('ai', aiText);
            this.processResponsePayload(aiText);
            
            console.log(`[AI Flow] Respuesta recibida y procesada.`);
        } catch (err) {
            console.error('[AI Chat Error] Detalle completo:', err);
            
            // Si el error persiste, intentamos simplificar el esquema
            try {
                console.log('[AI Flow] Reintentando con esquema simplificado...');
                const result = await AppState.aiInstance.models.generateContent({
                    model: "gemini-3-flash-preview",
                    contents: text,
                    config: { systemInstruction: this.getSystemPrompt() }
                });
                
                if (result.text) {
                    this.addMessage('ai', result.text);
                    this.processResponsePayload(result.text);
                    return;
                }
            } catch (retryErr) {
                console.error('[AI Chat Retry Error]', retryErr);
            }
            
            this.addMessage('ai', 'Lo siento, hubo un problema al conectar con mis circuitos de procesamiento. ¿Podrías intentarlo de nuevo?');
        } finally {
            this.setLoading(false);
        }
    },

    addMessage(role, text) {
        const container = $('ai-chat-container');
        if (!container) return;

        // Limpiar bienvenida si es el primer mensaje
        if (AppState.aiMessages.length === 0) {
            container.innerHTML = '';
        }

        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${role}`;
        
        // Remove trigger from display text
        const displayText = text.replace(/\[TRIGGER: .*?\]/g, '').trim();
        bubble.textContent = displayText;
        
        container.appendChild(bubble);
        AppState.aiMessages.push({ role, text });
        
        // Scroll to bottom
        const scroll = $('ai-chat-scroll');
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
    },

    setLoading(loading) {
        const btn = $('ai-send');
        const input = $('ai-input');
        if (btn) btn.disabled = loading;
        if (input) input.disabled = loading;
        
        if (loading) {
            const container = $('ai-chat-container');
            const typing = document.createElement('div');
            typing.id = 'ai-typing-indicator';
            typing.className = 'chat-bubble ai typing';
            typing.textContent = 'Escribiendo...';
            container.appendChild(typing);
        } else {
            const typing = $('ai-typing-indicator');
            if (typing) typing.remove();
        }
    },

    processResponsePayload(text) {
        const match = text.match(/\[TRIGGER: (.*?)\]/);
        if (match && match[1]) {
            const title = match[1].trim();
            console.log(`[AI Trigger] Detectado título: ${title}`);
            showToast(`🔎 Buscando: ${title}`);
            this.autoSearchAndOpen(title);
        }
    },

    async autoSearchAndOpen(title) {
        try {
            const results = await API.search(title);
            if (results.success && results.data && results.data.length > 0) {
                // Buscamos coincidencia parcial o la primera opción
                const term = title.toLowerCase();
                const match = results.data.find(a => 
                    a.title.toLowerCase().includes(term) || 
                    term.includes(a.title.toLowerCase())
                ) || results.data[0];
                
                showToast(`✨ ¡Encontrado! Abriendo ${match.title}...`);
                setTimeout(() => {
                    DetailOverlay.open(match.id);
                }, 1800);
            } else {
                console.log('[AI AutoSearch] No hay coincidencias en catálogo para:', title);
                showToast(`No encontré "${title}" en el catálogo actual.`);
            }
        } catch (err) {
            console.warn('[AI AutoSearch] Error:', err);
        }
    },

    setup() {
        const sendBtn = $('ai-send');
        const input = $('ai-input');
        
        if (sendBtn && input) {
            const submit = () => {
                const text = input.value.trim();
                if (text) {
                    this.sendMessage(text);
                    input.value = '';
                    input.style.height = 'auto';
                }
            };

            sendBtn.onclick = submit;
            input.onkeydown = (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                }
            };
            
            input.oninput = () => {
                input.style.height = 'auto';
                input.style.height = input.scrollHeight + 'px';
            };
        }

        document.querySelectorAll('.ai-suggestion-chip').forEach(chip => {
            chip.onclick = () => {
                this.sendMessage(chip.textContent);
            };
        });
    }
};

// ==================== LIBRARY ====================
const Library = {
    render() {
        const grid = $('library-grid');
        const empty = $('library-empty');

        if (!grid) return;

        grid.innerHTML = '';
        
        if (AppState.library.length === 0) {
            if (empty) empty.style.display = 'flex';
        } else {
            if (empty) empty.style.display = 'none';
            AppState.library.forEach((item, idx) => {
                const card = UIBuilder.buildCard(item);
                card.style.animationDelay = `${idx * 0.05}s`;
                grid.appendChild(card);
            });
        }
    },

    toggle(anime) {
        const idx = AppState.library.findIndex(a => a.id === anime.id);
        
        if (idx > -1) {
            AppState.library.splice(idx, 1);
            showToast('Eliminado de la biblioteca');
            Recommendations.registerFavorite(anime, false);
        } else {
            AppState.library.push({
                id: anime.id,
                title: anime.title,
                cover: anime.cover
            });
            showToast('Guardado en la biblioteca');
            Recommendations.registerFavorite(anime, true);
        }

        localStorage.setItem('anime_library', JSON.stringify(AppState.library));
        DetailOverlay.updateLibraryBtn();
        this.render();
    },

    setup() {
        const btn = $('btn-library');
        if (btn) {
            btn.addEventListener('click', () => {
                if (AppState.currentAnime) {
                    this.toggle(AppState.currentAnime);
                }
            });
        }
    }
};

// ==================== NAVIGATION ====================
const Navigation = {
    currentView: 'view-home',
    setup() {
        document.querySelectorAll('.nav-item-premium').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.dataset.target;
                
                // Si tocamos el botón de buscar y ya estamos en buscar, reseteamos a categorías
                if (target === 'view-search' && this.currentView === 'view-search') {
                    Search.reset();
                }

                this.switchView(target);
            });
        });

        const btnBackCat = $('btn-back-category');
        if (btnBackCat) {
            btnBackCat.addEventListener('click', () => {
                this.switchView('view-home');
            });
        }

        const btnCloseDetail = $('btn-close-detail');
        if (btnCloseDetail) {
            btnCloseDetail.addEventListener('click', () => {
                DetailOverlay.close();
            });
        }

        const btnClosePlayer = $('btn-close-player');
        if (btnClosePlayer) {
            btnClosePlayer.addEventListener('click', () => {
                PlayerOverlay.close();
            });
        }

        const btnFullscreen = $('btn-fullscreen-player');
        if (btnFullscreen) {
            btnFullscreen.addEventListener('click', () => {
                const container = $('overlay-player');
                if (container) {
                    if (!document.fullscreenElement) {
                        if (container.requestFullscreen) {
                            container.requestFullscreen();
                        } else if (container.webkitRequestFullscreen) { /* Safari */
                            container.webkitRequestFullscreen();
                        } else if (container.msRequestFullscreen) { /* IE11 */
                            container.msRequestFullscreen();
                        }
                    } else {
                        if (document.exitFullscreen) {
                            document.exitFullscreen();
                        } else if (document.webkitExitFullscreen) { /* Safari */
                            document.webkitExitFullscreen();
                        } else if (document.msExitFullscreen) { /* IE11 */
                            document.msExitFullscreen();
                        }
                    }
                }
            });
        }
    },

    switchView(target) {
        this.currentView = target;
        document.querySelectorAll('.view').forEach(v => {
            v.classList.remove('active');
        });
        const targetEl = $(target);
        if (targetEl) targetEl.classList.add('active');

        document.querySelectorAll('.nav-item-premium').forEach(n => {
            n.classList.remove('active');
        });
        const navBtn = document.querySelector(`[data-target="${target}"]`);
        if (navBtn) navBtn.classList.add('active');

        // Asegurar que los géneros de búsqueda se carguen al entrar
        if (target === 'view-search') {
            const input = $('search-input');
            if (input && input.value.trim().length === 0) {
                const message = $('search-message');
                if (message) {
                    message.style.display = 'flex';
                    // Animación de entrada para el buscador vacío
                    message.style.animation = 'fadeInUp 0.6s ease-out forwards';
                }
                Search.renderDiscoverGenres();
            }
        }
    }
};

// ==================== SETTINGS ====================
const Settings = {
    setup() {
        const btn = $('btn-clear-cache');
        if (btn) {
            btn.addEventListener('click', () => {
                if (confirm('¿Limpiar todos los datos locales? (Biblioteca e Historial)')) {
                    localStorage.clear();
                    location.reload();
                }
            });
        }

        const apiKeyInput = $('gemini-api-key');
        const saveKeyBtn = $('btn-save-key');
        
        if (apiKeyInput && saveKeyBtn) {
            apiKeyInput.value = AppState.apiKey || '';
            saveKeyBtn.onclick = () => {
                const key = apiKeyInput.value.trim();
                if (key) {
                    AppState.apiKey = key;
                    localStorage.setItem('gemini_api_key', key);
                    showToast('API Key guardada correctamente');
                    AIManager.init();
                } else if (confirm('¿Deseas eliminar la API Key?')) {
                    AppState.apiKey = null;
                    localStorage.removeItem('gemini_api_key');
                    AIManager.init();
                }
            };
        }
    }
};

// ==================== APP INIT ====================
const App = {
    async init() {
        Recommendations.init();
        Navigation.setup();
        AIManager.setup();
        DetailOverlay.setup();
        Library.setup();
        Library.render();
        Search.setup();
        Settings.setup();
        CategoryManager.setupScroll();
        HomeManager.bindFilterChips();
        UIBuilder.renderHistorySection();
        this.registerSW();
        this.setupPWA();
        
        await HomeManager.initializeSections(false);
        HomeManager.renderPersonalizedSection();
        AIManager.init();
    },

    registerSW() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js')
                    .then(reg => console.log('[SW] Registrado con éxito', reg))
                    .catch(err => console.error('[SW] Error al registrar', err));
            });
        }
    },

    setupPWA() {
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            AppState.deferredPrompt = e;
            const installBtn = $('btn-install-app');
            if (installBtn) {
                installBtn.style.display = 'flex';
                installBtn.onclick = async () => {
                    if (AppState.deferredPrompt) {
                        AppState.deferredPrompt.prompt();
                        const { outcome } = await AppState.deferredPrompt.userChoice;
                        console.log(`[PWA] El usuario eligió: ${outcome}`);
                        AppState.deferredPrompt = null;
                        installBtn.style.display = 'none';
                    }
                };
            }
        });

        window.addEventListener('appinstalled', () => {
             AppState.deferredPrompt = null;
             const installBtn = $('btn-install-app');
             if (installBtn) installBtn.style.display = 'none';
             showToast('¡App instalada con éxito!');
        });
    }
};

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
