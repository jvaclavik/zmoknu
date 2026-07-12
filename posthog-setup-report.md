<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the **zmoknu** weather app. PostHog is initialised once in `src/main.tsx` using environment variables, and 12 events are captured across three files covering the core user journeys: location discovery, favourites management, radar usage, link sharing, language/model preferences, and the notifications feature.

| Event name | Description | File |
|---|---|---|
| `location_searched` | User typed a query in the location search panel. | `src/components/SearchBar.tsx` |
| `location_selected` | User picked a location from search results or favourites. | `src/components/SearchBar.tsx` |
| `geolocation_used` | User tapped 'Use my location' to detect their position via GPS. | `src/App.tsx` |
| `favorite_added` | User starred a location to add it to their favourites. | `src/App.tsx` |
| `favorite_removed` | User removed a location from their favourites. | `src/App.tsx` |
| `radar_opened` | User opened the precipitation radar map. | `src/App.tsx` |
| `link_shared` | User shared or copied the deep-link for the current location. | `src/App.tsx` |
| `language_changed` | User switched the app language (Czech / English). | `src/App.tsx` |
| `weather_model_changed` | User selected a different weather data source model. | `src/App.tsx` |
| `notification_settings_opened` | User opened the weather notification settings panel. | `src/App.tsx` |
| `notification_permission_granted` | User granted browser permission for weather notifications. | `src/components/NotifySettings.tsx` |
| `notification_rule_added` | User added a new weather alert rule in the notifications panel. | `src/components/NotifySettings.tsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behaviour, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://eu.posthog.com/project/222454/dashboard/813478)
- [Location selections over time (wizard)](https://eu.posthog.com/project/222454/insights/Ly7sfwnf)
- [Location selected by method (wizard)](https://eu.posthog.com/project/222454/insights/6B1ef35x)
- [Radar opens per day (wizard)](https://eu.posthog.com/project/222454/insights/6PpHb8kW)
- [Language preference (wizard)](https://eu.posthog.com/project/222454/insights/6EWkoYgy)
- [Notification rules added by type (wizard)](https://eu.posthog.com/project/222454/insights/Y5GIv9O9)

## Verify before merging

- [ ] Run a full production build (the wizard only verified the files it touched) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `VITE_PUBLIC_POSTHOG_KEY` and `VITE_PUBLIC_POSTHOG_HOST` to `.env.example` and any bootstrap scripts so collaborators know what to set.
- [ ] Wire source-map upload (`posthog-cli sourcemap` or your bundler's upload step) into CI so production stack traces de-minify.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
