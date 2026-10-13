# Directory submissions

Everything needed to list the Gentifi network connector (`https://mcp.gentifi.com/mcp`) in Claude's Connectors Directory and ChatGPT's plugin directory. The connector needs no sign-in and only reads: it never orders, sends or pays for anything.

| | Claude | ChatGPT |
| --- | --- | --- |
| Where | [claude.ai/directory/manage](https://claude.ai/directory/manage), **Submit new**, then **MCP connector** | [OpenAI Platform](https://platform.openai.com), **Plugins**, then **Upload new or existing plugin** |
| Who can submit | Any paid Claude plan | An organisation owner, after identity verification |
| What you upload | Answers typed into the portal (below) | `openai/` zipped, plus answers in the dashboard |
| Docs | [Submit a connector](https://claude.com/docs/connectors/building/submission), [review criteria](https://claude.com/docs/connectors/building/review-criteria) | [Submit plugins](https://developers.openai.com/plugins/deploy/submission), [guidelines](https://developers.openai.com/plugins/plugin-guidelines), [review](https://developers.openai.com/plugins/deploy/app-review) |

## Before either submission

- [ ] `https://gentifi.com/connector` (documentation) and `https://gentifi.com/privacy#connector` (privacy policy) are live.
- [ ] Every tool has been run as a custom connector in Claude and ChatGPT, with the test prompts below.
- [ ] At least one real business is live on the connector alongside the demo shop, so the listing does what it says.

## Test prompts (both directories)

Hollow Lane Farm Shop is a fictional demo shop, and its data never changes.

| Prompt | Tool | Expected |
| --- | --- | --- |
| Which shops on Gentifi have eggs? | `find_businesses` | Hollow Lane Farm Shop, with its free-range eggs (dozen) |
| Does Hollow Lane Farm Shop have free-range eggs? | `search_catalogue` | Yes: £3.20 per box of a dozen, in stock, with when prices were last updated |
| When is Hollow Lane Farm Shop open? | `get_business_info` | Tuesday to Saturday, 9am to 5pm |
| Could I get 3 sourdough loaves from Hollow Lane Farm Shop? | `check_availability` | Yes, £4.50 each, baked Friday and Saturday |
| Reserve a dozen eggs at Hollow Lane Farm Shop for Saturday. | `prepare_order` | A summary (total £3.20, Saturday) and an email link the customer can choose to send; nothing is ordered or sent |

Where it should not act:

| Prompt | Expected |
| --- | --- |
| Pay Hollow Lane Farm Shop for my eggs with my card. | Explains Gentifi takes no payments; the customer confirms and pays with the shop |
| Find me a plumber in Manchester on Gentifi. | No matching business on Gentifi |
| Change the price of eggs at Hollow Lane Farm Shop to £1. | Explains it can only read shops' information |

## Claude: portal answers

1. **Connection:** `https://mcp.gentifi.com/mcp`, one URL for all users.
2. **Tools:** five tools sync, all read-only, each with a title: `find_businesses`, `get_business_info`, `search_catalogue`, `check_availability`, `prepare_order`.
3. **Listing**
   - Name: Gentifi
   - One-liner: Ask independent local shops what they have, check prices and opening times, and prepare reservations you confirm yourself.
   - Description: use the long description from `openai/plugin.json`.
   - Categories: Shopping, or the closest the portal offers.
   - Documentation: `https://gentifi.com/connector`
   - Privacy policy: `https://gentifi.com/privacy#connector`
   - Support: gentifiai@gmail.com
   - Icon: `openai/assets/logo.png`
   - Slug: `gentifi` (permanent once published)
4. **Use cases:** finding local independent shops; checking products, prices, stock and opening times; preparing a reservation or order that the customer confirms with the shop. Users need nothing before connecting. The connector **reads data only**.
5. **Company:** Gentifi, `https://gentifi.com`, with your name and gentifiai@gmail.com as the primary contact.
6. **Authentication:** no authentication. All data is shops' public catalogues.
7. **Data handling:** our own API (the Gentifi host serves each business's catalogue, which the business provides). No personal health data and no sponsored content.
8. **Test & launch:** no account needed. Add `https://mcp.gentifi.com/mcp` as a custom connector, then run the test prompts above. Confirm you've run every tool.
9. **Compliance:** the connector moves no money (prepare_order only returns a summary and an email link), generates no media, doesn't collect conversation data, and has public documentation.

## ChatGPT: steps

1. **Verify** your identity in OpenAI Platform organisation settings: individual verification to publish as yourself, or business verification to publish as a company. The `developerName` in `openai/plugin.json` must match the name you verify; change it from "Gentifi" if you verify as an individual.
2. **Zip** the contents of `openai/` (the files, not the folder):
   ```bash
   cd directory/openai && zip -r ../gentifi-plugin.zip . && cd -
   ```
3. **Upload** it under Plugins, choosing your verified identity. Pick the closest category to Shopping if the dashboard asks.
4. **Connect the MCP server.** The portal shows a domain-verification token. Put it on the VPS, and the host serves it at `https://mcp.gentifi.com/.well-known/openai-apps-challenge`:
   ```bash
   echo 'PASTE-TOKEN-HERE' > /srv/gentifi/businesses/.openai-apps-challenge
   ```
   Then choose **No authentication**, connect, and wait for the tool scan.
5. **Review information:** the test cases come from the ZIP. Add a **video walkthrough** URL: a screen recording of the five positive prompts in ChatGPT (an unlisted YouTube or Google Drive link works). No reviewer credentials are needed.
6. **Submit for review** and accept the attestations. Feedback arrives by email. Once approved, choose **Publish plugin**.

## After listing

- Put the listing links on scan pages as the main button ("Add Gentifi in Claude", "Add Gentifi in ChatGPT"), keeping copy-the-link for other apps.
- Move "One-tap adding" and "Gentifi network" from Coming next to Today on gentifi.com.
- Tool changes are re-scanned by both directories; keep tool names and annotations stable.
