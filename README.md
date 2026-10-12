# OVERLOOK Website

Official static website and public feedback portal for OVERLOOK, an Android TV entertainment discovery and launcher application.

This repository contains only public website files and GitHub Issue Forms. It is intentionally independent from the private Android application repository and does not contain application source code, build files, binaries, credentials, private service configuration, or internal development documentation.

## Local preview

The site uses GitHub Pages project-path URLs. Serve the parent `/workspace` directory so `/overlook-website/` resolves exactly as it will in production:

```sh
python3 -m http.server 8080 --directory /workspace
```

Open `http://localhost:8080/overlook-website/`.

## Structure

- `index.html`: landing page, features, setup flow, and availability
- `feedback/`: public bug-report and feature-request portal
- `about/`: product purpose and design principles
- `contact/`: official identity, public contact, and Wikimedia identification guidance
- `.github/ISSUE_TEMPLATE/`: GitHub YAML Issue Forms
- `assets/`: local styles, scripts, original brand graphics, and reviewed public screenshots

Guide and Sports screenshots in `assets/images/screenshots/` are permanently
blurred public derivatives. Their unblurred originals are not part of this
repository. Home and Search are metadata-stripped, proportionally downscaled
captures from the application.

## Publication checklist

Publication requires explicit owner approval. Before publishing:

1. Confirm the GitHub owner is `ViolentPoo` or update every canonical URL, repository URL, issue link, `robots.txt`, and `sitemap.xml`.
2. Approve or replace the private operational contact language on the Contact page.
3. Review all product statements for accuracy against the current application.
4. Create a public repository named `overlook-website` with Issues enabled.
5. Create the `bug`, `enhancement`, and `needs-triage` labels before accepting reports.
6. Push only this repository's reviewed files and enable GitHub Pages from the `main` branch root.
7. Verify the published pages, HTTPS, navigation, issue forms, and repository contents.

## Dependencies

None. The site is plain HTML, CSS, and JavaScript with no build step, analytics, tracking cookies, external fonts, or runtime asset requests.
