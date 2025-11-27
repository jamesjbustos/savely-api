# Crawling and Updating DB

Goal: Our system will run a cron job that will use different methods such api calls or html extraction to update the following:

`provider_brand_urls` health: `last_checked_at`, `last_status`, `last_error`, `retry_count`.

Update `brand_discounts` snapshot for that (provider, brand): `max_discount_percent`, `in_stock`, `product_url`, `fetched_at`.

**List of providers**

- GCX (https://gcx.raise.com)
- CardCash (http://cardcash.com)
- CardCookie (https://cardcookie.com/)
- ArbitrageCard (https://arbitragecard.com/giftcards/)
- CardCenter (https://cardcenter.cc/Shop)
- GiftCardOutlets (https://www.giftcardoutlets.com/buy-gift-cards)
- CardDepot (https://carddepot.com)
- GiftCardSaving (https://www.giftcardsaving.com)

**Providers we can use**

- Cardcash (Official API Access)
- Cardcookie (No TOS violation on scraping data, one request required)
- CardCenter (No TOS violation on scraping data, one request required)
- CardDepot (Offical API Access)

**Providers we can't**

- Arbitrage Card
- GCX

## How ?

- **🔴 GCX 🔴**:

  - 🔴 TOS Prohibited, Contact for API access.
  - Summary: GCX has a public endpoint that we can use to iterate over each gcx supported brand and update our values in our db. Since gcx has supported around 5k brands but only ~10% of those are active, we'll be required to only crawl the most popular brands which we can determine by its constant availbility and we can crawl the other brands less frequent. Unfortunately theres no api yet that i've found on their frontend that solely returns all the in stock brands but thats in the backlog.
  - GCX exposes a public endpoint we can use to update our params. The endpoint we can use is: GET: "https://gcx.raise.com/query?type=paths&keywords=domino-s". Where the slug at the end is part of our `product_url` in our `provider_brand_urls` table. For instance: "https://gcx.raise.com/buy-domino-s-gift-cards".
  - Once the request is made our response looks like the following:

  ```
    {
        "available": true,
        "balanceCheckPhone": "8772502278",
        "balanceCheckUrl": "https://wbiprod.storedvalue.com/wbir/clients/dominos",
        "cardType": {
            "physical": false,
            "electronic_voucher": true,
            "electronic_online": true,
            "redemption_instructions": "Online:\r\nWhen paying for your purchase at www.dominos.com, on the checkout page, enter the 19-digit gift card number and 4-digit PIN.\r\n\r\nIn Store:\r\nSimply take your gift card with you to any Domino’s® store.",
            "print_only": false
        },
        "cardTypeId": "16be752c-0101-4f22-b0a7-10ee38969143",
        "cashBack": "5.00",
        "coverImageUrl": "https://s3.amazonaws.com/raise-content/bci/dominos_banner.jpg",
        "description": "Pizza solves a lot of problems. Or is it something else? Either way, everyone loves pizza, right? So why not buy a Domino’s gift card on GCX? At GCX, our goal is to put cash back in your pocket, and we do that by offering discount gift cards that offer savings you can’t pass up. If you’re having pizza for dinner tonight, pay for it with a discount gift card.\r\n\r\nDomino’s is one of the largest pizza chains in the United States, and its pizza speaks to that achievement. When you buy a gift card through GCX, you can enjoy savings on pizza, breadsticks, cheese sticks, pasta, sandwiches, wings, and boneless chicken. The gift cards cover anything on the menu. It’s all delicious, so which will you choose? With the savings you earned from your discount gift card, you might get something extra. Sign up for a Domino's Pizza account, and you'll get even more deals.\r\n\r\nDon’t keep all the pizza for yourself, though. Buy a Domino’s gift card for someone you care about and show them that pizza makes everything better. College students, teachers, working parents, or anyone who loves pizza will enjoy getting a gift card from you, and you’ll enjoy the money you saved by getting it from GCX. If you want to sell a Domino's gift card, you can so so at GCX, and earn up to 85% back!",
        "electronic": true,
        "iconUrl": "https://www.raise.com/raise-content/MP-OPs/Dominos/Dominos-logo.png",
        "id": "4bd4c64a-269b-4be8-84f3-0a2aa189dfbd",
        "instantConfig": {
            "increment": 1,
            "max_value": 10000,
            "min_value": 1000,
            "denominations": [
                2500,
                5000,
                7500,
                10000
            ],
            "gifting_supported": true,
            "disclaimer": "Redeemable In-Store or Online. Only two gift cards may be used per transaction. Gift cards can not be used for future (non-immediate) orders."
        },
        "instantConfigId": "85f13fca-544a-49fb-90d9-4b2278f3153a",
        "instantCoverImageUrl": "https://s3.amazonaws.com/raise-content/ibci/BANNER_dominos.jpg",
        "legacyBrandId": "c36a387d-4a3f-4d39-b3cb-d2fc7628d887",
        "name": "Domino’s®",
        "path": "/domino-s",
        "productSourceId": "16",
        "quantity_available": 1545,
        "rating": "3.1",
        "ratingCount": 571,
        "ratingUpdatedAt": "2025-05-15 02:29:16",
        "savings": "16.40",
        "sellingRate": {
            "last_two_days": 420,
            "last_day": 175,
            "last_hour": 0
        },
        "src": "https://www.raise.com/raise-content/MP-OPs/Dominos/Dominos-logo.png",
        "acceptedAt": []
    }
  ```

  - The important params for our use case is `savings` and `quantity_available`. Using this data we can update our max discount and wether the item in stock or not.

- **🟢 CardCash 🟢**:

  - TOS doesn't contain any scraping language and we are currently partnered. Official API lacks max discount
  - Summary: Cardcash has a endpoint that returns all the data we need, the only issue is it requires a anonymous cookie to maket the request. This cookie will be generated using an external script that will be fed to the worker when it needs to reach the endpoint and extract the latest data.
  - CardCash exposes the following api endpoint on their site: "https://production-api.cardcash.com/v3/merchants/buy?cache=bust". This GET request requires a cookie which is generated using playwright and has a time expiration of 20 minutes. The cookie will be supplied to the worker upon request. The response from this endpoint contains the entire gift card list and all the params we need, which means we only make one api call for each crawl. Heres a snippet of the response
  - ````
    {
    "buyMerchants": [
        {
            "id": 753,
            "name": "1 800 Flowers.com",
            "cardsAvailable": 150,
            "ecodesAvailable": 150,
            "upToPercentage": 15,
            "image": "https://cdn.cardcash.com/images/merchants/800flowers.png",
            "slug": "discount-1-800-flowerscom-cards",
            "primaryColor": "#5e3987",
            "aliases": [
                "1800Flowers"
            ],
            "cardType": "ecode",
            "popular": 559,
            "sellIsOff": 0,
            "featured": null,
            "maxFaceValue": 500,
            "minFaceValue": 10,
            "affiliate_link": null
        },
        {
            "id": 2041,
            "name": "1-800 Baskets.com",
            "cardsAvailable": 100,
            "ecodesAvailable": 100,
            "upToPercentage": 15,
            "image": "https://cdn.cardcash.com/images/merchants/800baskets.png",
            "slug": "discount-1-800-basketscom-cards",
            "primaryColor": null,
            "aliases": [],
            "cardType": "ecode",
            "popular": 0,
            "sellIsOff": 0,
            "featured": null,
            "maxFaceValue": 100,
            "minFaceValue": 10,
            "affiliate_link": null
        },
        {
            "id": 126,
            "name": "1800PetSupplies.com",
            "cardsAvailable": 50,
            "ecodesAvailable": 50,
            "upToPercentage": 7,
            "image": "https://cdn.cardcash.com/images/merchants/1-800-Pet-Supplies.png",
            "slug": "discount-1800petsuppliescom-cards",
            "primaryColor": "#FB7038",
            "aliases": [],
            "cardType": "ecode",
            "popular": 0,
            "sellIsOff": 1,
            "featured": null,
            "maxFaceValue": 50,
            "minFaceValue": 25,
            "affiliate_link": "http://www.petsupplies.com/CS/GiftCard.aspx"
        },
        ```
        - The important params for use case is `cardsAvailable`, `ecodeAvailable`, `upToPercentage`.
    ````

- **🟢 CardCookie 🟢**:

  - Does not mention anything about scraping on their TOS
  - Summary: I've tried to find endpoints on the cardcookie website but theres none that is available on the frontend, but going to keep trying. The currents solution is to scrap the homepage which contains all the cards available and their discount.
  - CardCookie doesn't expose any endpoints on its site, however, we can reach the entire list of cards on their landing page "https://cardcookie.com/". Heres the sample response
  - ```
    <div class="row gift-card-grid"><div class="giftCard"><a id="link-target" data="8%" href="/buy-gift-cards/target" title="Target (online only)" class="giftCard-link"><div style="background-color:#CC0000" class="gcr-wrapper"><p class="gcr-placeholder">Target</p><img src="/img/brand-cards/target.2BA4F9F3DFE76BCA4AFB97CFF6E1A1.cached.svg" alt="buy target discounted gift card" class="gcr-img"></div><span class="giftCard-name">Target (online only)</span><span class="giftCard-discount">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-walmart" data="5%" href="/buy-gift-cards/walmart" title="Walmart" class="giftCard-link"><div style="background-color:#1A75CF" class="gcr-wrapper"><p class="gcr-placeholder">Walmart</p><img src="/img/brand-cards/walmart.91A734F0CC5A1BC356EA94514798977.cached.svg" alt="buy walmart discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Walmart Sale!</span><span class="giftCard-discount onSale">Save Up to 5%</span></a></div><div class="giftCard"><a id="link-best-buy" data="9%" href="/buy-gift-cards/best-buy" title="Best Buy" class="giftCard-link"><div style="background-color:#013D6B" class="gcr-wrapper"><p class="gcr-placeholder">Best Buy</p><img src="/img/brand-cards/best-buy.CDDCAE1B78A36FBB87A2ADFDFA4C1A8E.cached.svg" alt="buy best-buy discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Best Buy Sale!</span><span class="giftCard-discount onSale">Save Up to 9%</span></a></div><div class="giftCard"><a id="link-home-depot" data="8%" href="/buy-gift-cards/home-depot" title="Home Depot" class="giftCard-link"><div style="background-color:#FF6600" class="gcr-wrapper"><p class="gcr-placeholder">Home Depot</p><img src="/img/brand-cards/home-depot.48BB6F83656D234B4BAC4FF68BB1915.cached.svg" alt="buy home-depot discounted gift card" class="gcr-img"></div><span class="giftCard-name">Home Depot</span><span class="giftCard-discount">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-lowes" data="10%" href="/buy-gift-cards/lowes" title="Lowe's" class="giftCard-link"><div style="background-color:#224185" class="gcr-wrapper"><p class="gcr-placeholder">Lowe's</p><img src="/img/brand-cards/lowes.8391EEFDB264376FB9D347FB449FE66.cached.svg" alt="buy lowes discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Lowe's Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-dicks-sporting-goods" data="8%" href="/buy-gift-cards/dicks-sporting-goods" title="Dick's Sporting Goods" class="giftCard-link"><div style="background-color:#006554" class="gcr-wrapper"><p class="gcr-placeholder">Dick's Sporting Goods</p><img src="/img/brand-cards/dicks-sporting-goods.93F4EC86552952F11616FD5A5CBC6D0.cached.svg" alt="buy dicks-sporting-goods discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Dick's Sporting Goods Sale!</span><span class="giftCard-discount onSale">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-jcpenney" data="15%" href="/buy-gift-cards/jcpenney" title="JCPenney" class="giftCard-link"><div style="background-color:#CC0033" class="gcr-wrapper"><p class="gcr-placeholder">JCPenney</p><img src="/img/brand-cards/jcpenney.24D1C2CC839AF2935AE7BE8BD75C793.cached.svg" alt="buy jcpenney discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">JCPenney Sale!</span><span class="giftCard-discount onSale">Save Up to 15%</span></a></div><div class="giftCard"><a id="link-banana-republic" data="10%" href="/buy-gift-cards/banana-republic" title="Banana Republic" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Banana Republic</p><img src="/img/brand-cards/banana-republic.F6A2924F52B832589EA8256E3A97C69.cached.svg" alt="buy banana-republic discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Banana Republic Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-peets-coffee-and-tea" data="20%" href="/buy-gift-cards/peets-coffee-and-tea" title="Peet's Coffee &amp; Tea" class="giftCard-link"><div style="background-color:#2A1708" class="gcr-wrapper"><p class="gcr-placeholder">Peet's Coffee &amp; Tea</p><img src="/img/brand-cards/peets-coffee-and-tea.EFF48F31EDC8805B9929B2FB5FC13.cached.svg" alt="buy peets-coffee-and-tea discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Peet's Coffee &amp; Tea Sale!</span><span class="giftCard-discount onSale">Save Up to 20%</span></a></div><div class="giftCard"><a id="link-williams-sonoma" data="10%" href="/buy-gift-cards/williams-sonoma" title="Williams Sonoma" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Williams Sonoma</p><img src="/img/brand-cards/williams-sonoma.3CB7BE55AB3658DC66815CF675518593.cached.svg" alt="buy williams-sonoma discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Williams Sonoma Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-pottery-barn" data="12%" href="/buy-gift-cards/pottery-barn" title="Pottery Barn" class="giftCard-link"><div style="background-color:#663333" class="gcr-wrapper"><p class="gcr-placeholder">Pottery Barn</p><img src="/img/brand-cards/pottery-barn.98F9BCE24924D5F5A86DCC5D8849FA28.cached.svg" alt="buy pottery-barn discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Pottery Barn Sale!</span><span class="giftCard-discount onSale">Save Up to 12%</span></a></div><div class="giftCard"><a id="link-nike" data="10%" href="/buy-gift-cards/nike" title="Nike" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Nike</p><img src="/img/brand-cards/nike.BD9F78DD8C11E451CB8BA2F8B42A2524.cached.svg" alt="buy nike discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Nike Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-aeropostale" data="20%" href="/buy-gift-cards/aeropostale" title="Aeropostale" class="giftCard-link"><div style="background-color:#002D62" class="gcr-wrapper"><p class="gcr-placeholder">Aeropostale</p><img src="/img/brand-cards/aeropostale.6A9AF0831FBCA81781EDD7F9B5068C.cached.svg" alt="buy aeropostale discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Aeropostale Sale!</span><span class="giftCard-discount onSale">Save Up to 20%</span></a></div><div class="giftCard"><a id="link-crate-and-barrel" data="9%" href="/buy-gift-cards/crate-and-barrel" title="Crate &amp; Barrel" class="giftCard-link"><div style="background-color:#CCCCCC" class="gcr-wrapper"><p class="gcr-placeholder">Crate &amp; Barrel</p><img src="/img/brand-cards/crate-and-barrel.CA7C2A9C651D5D9426F6E259BAC1B7.cached.svg" alt="buy crate-and-barrel discounted gift card" class="gcr-img"></div><span class="giftCard-name">Crate &amp; Barrel</span><span class="giftCard-discount">Save Up to 9%</span></a></div><div class="giftCard"><a id="link-yankee-candle" data="10%" href="/buy-gift-cards/yankee-candle" title="Yankee Candle" class="giftCard-link"><div style="background-color:#EFBB2B" class="gcr-wrapper"><p class="gcr-placeholder">Yankee Candle</p><img src="/img/brand-cards/yankee-candle.FA2C680AA16EEEF639B64B12BC34F.cached.svg" alt="buy yankee-candle discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Yankee Candle Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-tiffany-and-co" data="15%" href="/buy-gift-cards/tiffany-and-co" title="Tiffany &amp; Co" class="giftCard-link"><div style="background-color:#81d8d0" class="gcr-wrapper"><p class="gcr-placeholder">Tiffany &amp; Co</p><img src="/img/brand-cards/tiffany-and-co.1D417E5C4F28FBF2333B7473AABB3E4E.cached.svg" alt="buy tiffany-and-co discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Tiffany &amp; Co Sale!</span><span class="giftCard-discount onSale">Save Up to 15%</span></a></div><div class="giftCard"><a id="link-aerosoles" data="5%" href="/buy-gift-cards/aerosoles" title="Aerosoles" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Aerosoles</p><img src="/img/brand-cards/aerosoles.A84861D79DE974274EA8666EB2A7294.cached.svg" alt="buy aerosoles discounted gift card" class="gcr-img"></div><span class="giftCard-name">Aerosoles</span><span class="giftCard-discount">Save Up to 5%</span></a></div><div class="giftCard"><a id="link-cb2" data="8%" href="/buy-gift-cards/cb2" title="CB2" class="giftCard-link"><div style="background-color:#E54100" class="gcr-wrapper"><p class="gcr-placeholder">CB2</p><img src="/img/brand-cards/cb2.EDA5777794F75B6F4E85CED6398D27F.cached.svg" alt="buy cb2 discounted gift card" class="gcr-img"></div><span class="giftCard-name">CB2</span><span class="giftCard-discount">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-hotelscom" data="10%" href="/buy-gift-cards/hotelscom" title="Hotels.com" class="giftCard-link"><div style="background-color:#e4e3e3" class="gcr-wrapper"><p class="gcr-placeholder">Hotels.com</p><img src="/img/brand-cards/hotelscom.EB2C94EA912A99E415C6182FE4BFCA.cached.svg" alt="buy hotelscom discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Hotels.com Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-newegg" data="5%" href="/buy-gift-cards/newegg" title="Newegg" class="giftCard-link"><div style="background-color:#929292" class="gcr-wrapper"><p class="gcr-placeholder">Newegg</p><img src="/img/brand-cards/newegg.FB7432F82DE856AB82A27512D5349ED9.cached.svg" alt="buy newegg discounted gift card" class="gcr-img"></div><span class="giftCard-name">Newegg</span><span class="giftCard-discount">Save Up to 5%</span></a></div><div class="giftCard"><a id="link-callaway-golf" data="20%" href="/buy-gift-cards/callaway-golf" title="Callaway Golf" class="giftCard-link"><div style="background-color:#6f6f6f" class="gcr-wrapper"><p class="gcr-placeholder">Callaway Golf</p><img src="/img/brand-cards/callaway-golf.23E0FEAA5549CFC5F32B71FDA316F9A3.cached.svg" alt="buy callaway-golf discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Callaway Golf Sale!</span><span class="giftCard-discount onSale">Save Up to 20%</span></a></div><div class="giftCard"><a id="link-kohls" data="10%" href="/buy-gift-cards/kohls" title="Kohl's" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Kohl's</p><img src="/img/brand-cards/kohls.C97CF9141DEFE61A29816D6B0B8861C.cached.svg" alt="buy kohls discounted gift card" class="gcr-img"></div><span class="giftCard-name">Kohl's</span><span class="giftCard-discount">Save Up to 10%</span></a></div><div class="giftCard"></div><div class="giftCard"></div><div class="giftCard"></div><div class="giftCard"></div></div>
    ```
    - Using the html we get back we extract the max discount and availability.

- **🔴 ArbitrageCard 🔴**:

  - Does not allow scraping in their TOS but a future partner, contact for api access.
  - Summary: ArbitrageCard is a woocommerce powered site which means we can easily find some public endpoints using "https://arbitragecard.com/wp-json". Currently the solution is to call two enpoints to get the result we need.
  - For this site we'll have to hit two endpoints to accomplish our goal of updating our db.
  - The first endpoint is GET "https://arbitragecard.com/wp-json/arbitragecard/v1/available-brands", this endpoint gives us all "available" brands can still be out of stock, its more like these are live brand links on our website. But we're going to assume its in stock if it is in this list and we match our db as so. This is because the next endopint doesn't have a reliablle "available" param. Heres a snippet of the response
  - `    [
{
    "product_id": "99961",
    "brand_name": "1-800-Flowers.com",
    "brand_logo": "https://arbitragecard.com/wp-content/uploads/2025/09/1800flowerscomSVGlogo.svg",
    "merchant_domain": "1800flowers.com"
},
{
    "product_id": "66646",
    "brand_name": "Abercrombie & Fitch",
    "brand_logo": "https://arbitragecard.com/wp-content/uploads/2025/06/AbercrombieSVGlogo.svg",
    "merchant_domain": "abercrombie.com"
},
{
    "product_id": "5165",
    "brand_name": "Academy",
    "brand_logo": "https://arbitragecard.com/wp-content/uploads/2025/04/Academy.svg",
    "merchant_domain": "academy.com"
},`
  - using the merchant_domain we can query our next endpoint which will give us our max discount: GET "https://arbitragecard.com/wp-json/arbitragecard/v1/available-gift-cards?merchant_domain=1800flowers.com"
  - Heres a snippet of the response, since the available param is not accurate we can ignore it and simply get the max discount. We'll assume its available since we got this brand back from the first endpoint reqeust -`    {
"available": 0,
"max_discount": 8,
"product_id": 99961,
"debug": [
    "99962===8",
    "99963===8",
    "99964===8",
    "99965===8",
    "99966===8",
    "99967===8"
]
}`

- **🟢CardCenter 🟢**:

  - TOS does not include any legal prohibition to crawling or public api access.
  - Summary: CardCenter makes it very easy we have this public endpoint (GET) "https://cardcenter.cc/Api/Shop/Brands" which returns all the data we need and only returns available cards.
  - The endpoint we can call is "https://cardcenter.cc/Api/Shop/Brands", this is a snippet of the response we get:
    `{
"items": [
    {
        "brand": {
            "name": "1-800-Baskets",
            "slug": "1-800-baskets",
            "type": "Standard",
            "id": 33967
        },
        "discounts": {
            "low": 0.0710000000000000000000000000,
            "high": 0.1230000000000000000000000000
        },
        "values": {
            "low": 5.0000000000000000000000000000,
            "high": 500.00000000000000000000000000
        }
    },
    {
        "brand": {
            "name": "1-800-Flowers",
            "slug": "1-800-flowers",
            "type": "Standard",
            "id": 1963
        },
        "discounts": {
            "low": 0.0710000000000000000000000000,
            "high": 0.1220000000000000000000000000
        },
        "values": {
            "low": 5.0000000000000000000000000000,
            "high": 500.00000000000000000000000000
        }
    },
    {
        "brand": {
            "name": "1-800-PetSupplies",
            "slug": "1-800-petsupplies",
            "type": "Standard",
            "id": 34543
        },
        "discounts": {
            "low": 0.0780000000000000000000000000,
            "high": 0.1080000000000000000000000000
        },
        "values": {
            "low": 25.000000000000000000000000000,
            "high": 50.000000000000000000000000000
        }
    },
   ` - using the reponse we get we can update all our cardcenter cards: their availbility (if not in list) and their max discount.

- **🔴 GiftCardOutlets 🔴**:

  - TOS doesn't allow data minin, scraping, bots, etc. Meaning we can't use their api endnpoint currently. Contact provider.
  - Summary: GiftCardOutlets is very simple we can use their exposed api endpoint and update our db, it contains all the values we need
  - GET https://www.giftcardoutlets.com/GetMerchatListForBuyPage
  - Snippet of response:
    `"{\r\n  \"Table\": [\r\n    {\r\n      \"mID\": 192,\r\n      \"mNm\": \"Adidas\",\r\n      \"vImg\": \"/GCS-IMG/cards/thumb1/adidas.png\",\r\n      \"pageURL\": \"adidas\",\r\n      \"TotalCards\": 16,\r\n      \"buyer_disc\": 2.000000,\r\n      \"rowNum\": 0,\r\n      \"uptoDisc\": 7.22\r\n    },\r\n    {\r\n      \"mID\": 208,\r\n      \"mNm\": \"Applebee\u0027s\",\r\n      \"vImg\": \"/GCS-IMG/cards/thumb1/applebees.png\",\r\n      \"pageURL\": \"applebee-s\",\r\n      \"TotalCards\": 1,\r\n      \"buyer_disc\": 8.990000,\r\n      \"rowNum\": 0,\r\n      \"uptoDisc\": 19.78\r\n    },\r\n    {\r\n      \"mID\": 848,\r\n      \"mNm\": \"At home\",\r\n      \"vImg\": \"/GCS-IMG/cards/thumb1/athome.png\",\r\n      \"pageURL\": \"at-home\",\r\n      \"TotalCards\": 1,\r\n      \"buyer_disc\": 6.000000,\r\n      \"rowNum\": 0,\r\n      \"uptoDisc\": 15.00\r\n    },\r\n    {\r\n      \"mID\": 241,\r\n      \"mNm\": \"Best Buy\",\r\n      \"vImg\": \"/GCS-IMG/cards/thumb1/bestbuy.png\",\r\n      \"pageURL\": \"best-buy\",\r\n      \"TotalCards\": 1,\r\n      \"buyer_disc\": 2.500000,\r\n      \"rowNum\": 0,\r\n      \"uptoDisc\": 3.82\r\n    },\r\n    {\r\n      \"mID\": 249,\r\n      \"mNm\": \"Black Angus\",\r\n      \"vImg\": \"/GCS-IMG/cards/thumb1/blackangus.png\",\r\n      \"pageURL\": \"black-angus\",\r\n      \"TotalCards\": 29,\r\n      \"buyer_disc\": 30.000000,\r\n      \"rowNum\": 0,\r\n      \"uptoDisc\": 37.00\r\n    },\r\n`
  - The data we get back needs to be extracted correctly, then we can update our db

- **🟢CardDepot🟢**:

  - TOS doesn't allow scraping

- **🔴GiftCardSaving🔴**:
