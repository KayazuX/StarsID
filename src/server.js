import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const {
  PORT = '8080',
  TMDB_API_KEY = '',
  GEMINI_API_KEY = '',
  GEMINI_MODEL = 'models/gemini-2.5-flash',
} = process.env;

const runtimeHost = '0.0.0.0';
const runtimePort = Number.parseInt(String(PORT), 10) || 8080;

if (!TMDB_API_KEY || !GEMINI_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn('TMDB_API_KEY ou GEMINI_API_KEY manquante dans l environnement runtime');
}

const tmdb = axios.create({
  baseURL: 'https://api.themoviedb.org/3',
  timeout: 12000,
});

const gemini = axios.create({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  timeout: 30000,
});

const toImageUrl = (path, size = 'w500') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);

const normalizeMediaType = (mediaType) => {
  if (mediaType === 'movie' || mediaType === 'tv') return mediaType;
  return null;
};

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'stars-id-proxy',
    message: 'Stars ID backend is running.',
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'stars-id-proxy',
    runtime: {
      host: runtimeHost,
      port: runtimePort,
      hasTmdbKey: TMDB_API_KEY.length > 0,
      hasGeminiKey: GEMINI_API_KEY.length > 0,
      geminiModel: GEMINI_MODEL,
    },
  });
});

app.get('/api/actors/search', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);

    if (!query) {
      return res.status(400).json({ message: 'query vide' });
    }

    const response = await tmdb.get('/search/person', {
      params: {
        api_key: TMDB_API_KEY,
        query,
        page,
        include_adult: false,
        language: 'fr-FR',
      },
    });

    const data = response.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    const filtered = results.filter((item) => !item.known_for_department || item.known_for_department === 'Acting');

    return res.json({
      page: data.page || page,
      total_pages: data.total_pages || 1,
      results: filtered,
    });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB search.' });
  }
});

app.get('/api/search/multi', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    const type = String(req.query.type || 'actor').trim().toLowerCase();
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);

    if (!query) {
      return res.status(400).json({ message: 'query vide' });
    }

    const endpointByType = {
      actor: '/search/person',
      movie: '/search/movie',
      tv: '/search/tv',
    };

    if (!endpointByType[type]) {
      return res.status(400).json({ message: 'type invalide (actor|movie|tv).' });
    }

    const response = await tmdb.get(endpointByType[type], {
      params: {
        api_key: TMDB_API_KEY,
        query,
        page,
        include_adult: false,
        language: 'fr-FR',
      },
    });

    const data = response.data || {};
    const results = Array.isArray(data.results) ? data.results : [];

    const mapped = results.map((item) => {
      if (type === 'actor') {
        const name = item?.name || 'Nom inconnu';
        return {
          id: item?.id,
          media_type: 'actor',
          title: name,
          subtitle: item?.known_for_department || 'Profession non renseignee',
          overview: item?.known_for?.map((k) => k?.title || k?.name).filter(Boolean).join(' • ') || '',
          poster_url: toImageUrl(item?.profile_path, 'w342'),
          year: null,
        };
      }

      const date = item?.release_date || item?.first_air_date || null;
      const year = date && /^\d{4}/.test(date) ? date.slice(0, 4) : null;
      const title = item?.title || item?.name || 'Titre inconnu';

      return {
        id: item?.id,
        media_type: type,
        title,
        subtitle: type === 'movie' ? 'Film' : 'Serie',
        overview: item?.overview || '',
        poster_url: toImageUrl(item?.poster_path, 'w342'),
        year,
      };
    }).filter((item) => typeof item.id === 'number');

    return res.json({
      page: data.page || page,
      total_pages: data.total_pages || 1,
      results: mapped,
    });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB recherche globale.' });
  }
});

app.post('/api/actors/recognize', upload.single('image'), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ message: 'Fichier image invalide.' });
    }

    const encoded = file.buffer.toString('base64');
    const model = GEMINI_MODEL.startsWith('models/') ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;

    const geminiInstruction = `[ROLE]
Agent specialized in actor recognition from images.

[CONTEXT]
The system receives an image containing an identifiable actor and must produce a strictly formatted response intended for automated API consumption.

[TASK]
Identify the main actor visible in the provided image and return only their first name and last name.

[REQUIREMENTS]
- Identify a single main actor when the image contains multiple people.
- Produce no explanation, justification, extra punctuation, or additional text.
- Never include titles, roles, aliases, nicknames, or biographical information.
- Output must be strictly limited to first name followed by last name.
- If the actor cannot be identified with certainty, use a neutral placeholder.
- Strict formatting constraint enforced by the caller.
- Given–When–Then: Given: an image containing an identifiable actor, When: the image is analyzed, Then: the first and last name of the main actor are returned with no additional content

[EXAMPLES]
Given: An image containing Scarlett Johansson
When: The image is analyzed
Then: Scarlett Johansson

[FORMAT]
{
"text": "[FirstName] [LastName]"
}

[INSTRUCTIONS]
- Neutral, factual, minimalist tone.
- Language: English.
- Assumption: the image is usable and contains at least one known actor.
- Strictly comply with the output format; any deviation is forbidden.
- Do not perform any action other than nominal identification.`;

    const extractActorName = (rawText) => {
      const extractedText = (() => {
        // Gemini peut renvoyer un JSON texte strict, on tente d extraire la cle "text".
        try {
          const parsed = JSON.parse(rawText);
          if (parsed && typeof parsed.text === 'string') {
            return parsed.text;
          }
        } catch {
          // Pas un JSON strict, on reutilise la chaine brute.
        }
        return rawText;
      })();

      // On conserve les caracteres Unicode alphabetiques (noms accentues inclus).
      return extractedText.replace(/[^\p{L}\s\-']/gu, ' ').replace(/\s+/g, ' ').trim();
    };

    const callGemini = async ({ instructionText, forceJson }) => {
      const response = await gemini.post(`/${model}:generateContent`, {
        contents: [
          {
            parts: [
              {
                text: instructionText,
              },
              {
                inlineData: {
                  mimeType: file.mimetype,
                  data: encoded,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 32,
          ...(forceJson ? { responseMimeType: 'application/json' } : {}),
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }, {
        params: { key: GEMINI_API_KEY },
      });

      const candidates = Array.isArray(response.data?.candidates) ? response.data.candidates : [];
      const textFromParts = candidates
        .flatMap((c) => Array.isArray(c?.content?.parts) ? c.content.parts : [])
        .map((part) => String(part?.text || '').trim())
        .find((value) => value.length > 0) || '';

      const textFromCandidate = candidates
        .map((c) => String(c?.output || c?.text || '').trim())
        .find((value) => value.length > 0) || '';

      const text = textFromParts || textFromCandidate;

      return {
        rawResponse: response.data,
        candidates,
        rawText: text,
        actorName: extractActorName(text),
        blockReason: response.data?.promptFeedback?.blockReason || null,
      };
    };

    let result = await callGemini({ instructionText: geminiInstruction, forceJson: true });

    if (!result.actorName) {
      // 2e tentative: meme instruction mais sortie texte libre.
      result = await callGemini({ instructionText: geminiInstruction, forceJson: false });
    }

    if (!result.actorName) {
      // Fallback de compatibilite: instruction courte qui fonctionnait avant la mise a jour.
      const legacyInstruction = 'Identifie uniquement l acteur ou l actrice principale visible. Retourne seulement nom et prenom, sans ponctuation ni texte supplementaire.';
      result = await callGemini({ instructionText: legacyInstruction, forceJson: false });
    }

    const actorName = result.actorName;

    if (!actorName) {
      // eslint-disable-next-line no-console
      console.warn('Gemini returned no usable actor name.', {
        blockReason: result.blockReason,
        rawText: result.rawText,
        candidateParts: (result.candidates || []).map((c) => c?.content?.parts || []),
        rawResponse: result.rawResponse,
      });
      return res.status(422).json({ message: 'Aucun acteur reconnu par Gemini.' });
    }

    return res.json({ actor_name: actorName });
  } catch (error) {
    const status = error?.response?.status;
    const providerMessage = error?.response?.data?.error?.message;
    const message = typeof providerMessage === 'string' && providerMessage.trim().length > 0
      ? `Erreur Gemini (${status || 502}) : ${providerMessage}`
      : 'Erreur proxy Gemini.';

    // eslint-disable-next-line no-console
    console.error('Gemini recognize error:', status || 'n/a', providerMessage || error?.message || error);
    return res.status(502).json({ message });
  }
});

app.get('/api/actors/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ message: 'id manquant' });

    const [detailResponse, externalIdsResponse] = await Promise.all([
      tmdb.get(`/person/${id}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR',
        },
      }),
      tmdb.get(`/person/${id}/external_ids`, {
        params: {
          api_key: TMDB_API_KEY,
        },
      }),
    ]);

    const actor = detailResponse.data || {};
    const externalIds = externalIdsResponse.data || {};
    const socialLinks = {
      instagram: externalIds.instagram_id ? `https://www.instagram.com/${externalIds.instagram_id}` : null,
      x: externalIds.twitter_id ? `https://x.com/${externalIds.twitter_id}` : null,
      facebook: externalIds.facebook_id ? `https://www.facebook.com/${externalIds.facebook_id}` : null,
      tiktok: externalIds.tiktok_id ? `https://www.tiktok.com/@${externalIds.tiktok_id}` : null,
      imdb: externalIds.imdb_id ? `https://www.imdb.com/name/${externalIds.imdb_id}` : null,
    };

    const nominationsCount = null;

    return res.json({
      id: actor.id,
      name: actor.name,
      biography: actor.biography,
      known_for_department: actor.known_for_department,
      profile_url: toImageUrl(actor.profile_path, 'w780'),
      popularity: actor.popularity || 0,
      nominations_count: nominationsCount,
      social_links: socialLinks,
    });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB detail acteur.' });
  }
});

app.get('/api/actors/:id/works', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ message: 'id manquant' });

    const response = await tmdb.get(`/person/${id}/combined_credits`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR',
      },
    });

    const cast = Array.isArray(response.data?.cast) ? response.data.cast : [];
    const works = cast
      .filter((item) => item?.media_type === 'movie' || item?.media_type === 'tv')
      .map((item) => {
        const title = item.title || item.name || 'Titre inconnu';
        const date = item.release_date || item.first_air_date || '';
        const year = /^\d{4}/.test(date) ? date.slice(0, 4) : null;
        return {
          id: item.id,
          media_type: item.media_type,
          title,
          year,
          poster_url: toImageUrl(item.poster_path, 'w342'),
          vote_average: item.vote_average || 0,
        };
      })
      .sort((a, b) => {
        const ay = parseInt(a.year || '0', 10);
        const by = parseInt(b.year || '0', 10);
        return by - ay;
      });

    return res.json({ works });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB filmographie.' });
  }
});

app.get('/api/works/:mediaType/:id/details', async (req, res) => {
  try {
    const mediaType = normalizeMediaType(String(req.params.mediaType || '').trim());
    const id = String(req.params.id || '').trim();

    if (!mediaType) {
      return res.status(400).json({ message: 'mediaType invalide (movie|tv).' });
    }
    if (!id) {
      return res.status(400).json({ message: 'id manquant' });
    }

    const [detailsResponse, videosResponse, creditsResponse, providersResponse] = await Promise.all([
      tmdb.get(`/${mediaType}/${id}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR',
        },
      }),
      tmdb.get(`/${mediaType}/${id}/videos`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR',
        },
      }),
      tmdb.get(`/${mediaType}/${id}/credits`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR',
        },
      }),
      tmdb.get(`/${mediaType}/${id}/watch/providers`, {
        params: {
          api_key: TMDB_API_KEY,
        },
      }),
    ]);

    const details = detailsResponse.data || {};
    const videos = Array.isArray(videosResponse.data?.results) ? videosResponse.data.results : [];
    const credits = creditsResponse.data || {};
    const cast = Array.isArray(credits.cast) ? credits.cast : [];
    const crew = Array.isArray(credits.crew) ? credits.crew : [];

    const trailer = videos.find((video) => video?.site === 'YouTube' && video?.type === 'Trailer') || null;

    const directorMovie = crew.find((member) => member?.job === 'Director')?.name || null;
    const creators = Array.isArray(details.created_by) ? details.created_by : [];
    const directorTv = creators.length > 0
      ? creators.map((person) => person?.name).filter(Boolean).join(', ')
      : null;

    const providerResults = providersResponse.data?.results || {};
    const regionProviders = providerResults.FR || providerResults.US || null;
    const providerPool = [
      ...(Array.isArray(regionProviders?.flatrate) ? regionProviders.flatrate : []),
      ...(Array.isArray(regionProviders?.buy) ? regionProviders.buy : []),
      ...(Array.isArray(regionProviders?.rent) ? regionProviders.rent : []),
    ];

    const seenProviderNames = new Set();
    const watchProviders = providerPool
      .map((provider) => provider?.provider_name)
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .filter((name) => {
        if (seenProviderNames.has(name)) return false;
        seenProviderNames.add(name);
        return true;
      })
      .slice(0, 8);

    const genres = Array.isArray(details.genres)
      ? details.genres.map((genre) => genre?.name).filter(Boolean)
      : [];

    const mappedCast = cast.slice(0, 20).map((member) => ({
      id: member?.id,
      name: member?.name,
      character: member?.character,
      profile_url: toImageUrl(member?.profile_path, 'w185'),
    }));

    const durationLabel = mediaType === 'movie'
      ? ((details.runtime && details.runtime > 0) ? `${details.runtime} min` : null)
      : ((details.number_of_seasons || details.number_of_episodes)
        ? `${details.number_of_seasons || 0} saison(s) • ${details.number_of_episodes || 0} episode(s)`
        : null);

    return res.json({
      id: details.id,
      media_type: mediaType,
      title: details.title || details.name,
      original_title: details.original_title || details.original_name,
      poster_url: toImageUrl(details.poster_path, 'w780'),
      backdrop_url: toImageUrl(details.backdrop_path, 'w780'),
      release_date: details.release_date || details.first_air_date || null,
      duration_label: durationLabel,
      synopsis: details.overview || null,
      director: mediaType === 'movie' ? directorMovie : directorTv,
      genres,
      trailer_url: trailer?.key ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      watch_providers: watchProviders,
      cast: mappedCast,
      vote_average: details.vote_average || 0,
    });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB detail oeuvre.' });
  }
});

app.get('/api/works/:mediaType/:id/similar', async (req, res) => {
  try {
    const mediaType = normalizeMediaType(String(req.params.mediaType || '').trim());
    const id = String(req.params.id || '').trim();
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);

    if (!mediaType) {
      return res.status(400).json({ message: 'mediaType invalide (movie|tv).' });
    }
    if (!id) {
      return res.status(400).json({ message: 'id manquant' });
    }

    const response = await tmdb.get(`/${mediaType}/${id}/similar`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR',
        page,
      },
    });

    const data = response.data || {};
    const results = Array.isArray(data.results) ? data.results : [];

    const mapped = results.map((item) => {
      const releaseDate = item?.release_date || item?.first_air_date || null;
      const year = releaseDate && /^\d{4}/.test(releaseDate) ? releaseDate.slice(0, 4) : null;
      return {
        id: item?.id,
        media_type: mediaType,
        title: item?.title || item?.name || 'Titre inconnu',
        year,
        poster_url: toImageUrl(item?.poster_path, 'w342'),
      };
    }).filter((item) => typeof item.id === 'number');

    return res.json({
      page: data.page || page,
      total_pages: data.total_pages || 1,
      results: mapped,
    });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB oeuvres similaires.' });
  }
});

app.get('/api/works/tv/:id/seasons', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const includeSpecials = String(req.query.include_specials || 'false').toLowerCase() === 'true';

    if (!id) {
      return res.status(400).json({ message: 'id manquant' });
    }

    const detailsResponse = await tmdb.get(`/tv/${id}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR',
      },
    });

    const details = detailsResponse.data || {};
    const baseSeasons = Array.isArray(details.seasons) ? details.seasons : [];
    const seasonsToFetch = baseSeasons
      .filter((season) => includeSpecials || Number(season?.season_number || 0) > 0)
      .map((season) => ({
        season_number: Number(season?.season_number || 0),
        name: season?.name || null,
        episode_count: Number(season?.episode_count || 0),
        air_date: season?.air_date || null,
      }))
      .sort((a, b) => a.season_number - b.season_number);

    const seasons = await Promise.all(seasonsToFetch.map(async (season) => {
      const seasonDetailsResponse = await tmdb.get(`/tv/${id}/season/${season.season_number}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR',
        },
      });

      const seasonDetails = seasonDetailsResponse.data || {};
      const episodes = Array.isArray(seasonDetails.episodes) ? seasonDetails.episodes : [];

      const mappedEpisodes = episodes
        .map((episode) => ({
          id: Number(episode?.id || 0),
          season_number: Number(episode?.season_number || season.season_number),
          episode_number: Number(episode?.episode_number || 0),
          name: episode?.name || `Episode ${episode?.episode_number || '?'}`,
          air_date: episode?.air_date || null,
          overview: episode?.overview || null,
          still_url: toImageUrl(episode?.still_path, 'w300'),
        }))
        .filter((episode) => episode.episode_number > 0)
        .sort((a, b) => a.episode_number - b.episode_number);

      return {
        season_number: season.season_number,
        name: seasonDetails?.name || season.name || `Saison ${season.season_number}`,
        air_date: seasonDetails?.air_date || season.air_date,
        episode_count: seasonDetails?.episodes?.length || season.episode_count,
        episodes: mappedEpisodes,
      };
    }));

    return res.json({
      series_id: Number(details.id || id),
      series_name: details.name || null,
      seasons,
    });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB saisons/episodes.' });
  }
});

app.get('/api/works/:mediaType/:id/monitor', async (req, res) => {
  try {
    const mediaType = normalizeMediaType(String(req.params.mediaType || '').trim());
    const id = String(req.params.id || '').trim();

    if (!mediaType) {
      return res.status(400).json({ message: 'mediaType invalide (movie|tv).' });
    }
    if (!id) {
      return res.status(400).json({ message: 'id manquant' });
    }

    const detailsResponse = await tmdb.get(`/${mediaType}/${id}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR',
      },
    });

    const details = detailsResponse.data || {};

    if (mediaType === 'movie') {
      return res.json({
        id: Number(details.id || id),
        media_type: 'movie',
        title: details.title || details.original_title || 'Titre inconnu',
        release_date: details.release_date || null,
        status: details.status || null,
      });
    }

    return res.json({
      id: Number(details.id || id),
      media_type: 'tv',
      title: details.name || details.original_name || 'Serie inconnue',
      number_of_seasons: Number(details.number_of_seasons || 0),
      number_of_episodes: Number(details.number_of_episodes || 0),
      next_episode_air_date: details.next_episode_to_air?.air_date || null,
      last_episode_air_date: details.last_episode_to_air?.air_date || null,
      last_episode_season_number: Number(details.last_episode_to_air?.season_number || 0),
      last_episode_number: Number(details.last_episode_to_air?.episode_number || 0),
      status: details.status || null,
    });
  } catch (error) {
    return res.status(502).json({ message: 'Erreur proxy TMDB monitoring oeuvre.' });
  }
});

app.listen(runtimePort, runtimeHost, () => {
  // eslint-disable-next-line no-console
  console.log(`Stars ID proxy running on http://${runtimeHost}:${runtimePort}`);
});
