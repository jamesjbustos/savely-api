# Cron

Context: I'm building an extension that serves giftcards to users as they visit websites such as Best Buy, Target, etc. To do this we originally used an API by CardBear which returned a list of each store they have and the gift card provider with the highest discount and the percentage amount. Since each provider has different urls for their giftcards, I created multiple scripts to seed my db with every brand they have and the respective url. With this we were able to connect the response from cardbear (higest reseller and amount) with the url we have stored in our db. This v1 api would take in the base url of the website (bestbuy.com) to get the appropriate response. This process was messy and required matching cardbear's data with ours to serve the correct url. Since then we've gotten direct offical/unoffical api access to most of the providers. This means we can mostly circumvent cardbear and constantly update our db values (max discount, availbility). We can update the following directly: Cardcash, Cardcookie, CardCenter, CardDepot. Since we're missing two providers from our provider list we'll have to depend on CardBear to fill in the missing values for GCX, Arbitrage Card. Since we're not going to the provider itself for these two providers we'll have to use CardBears data to update the latest max discount when gcx and arbitrage card are present for a brand. Ideally these operations would be a cron job that constantly updates our db, that way the frontend of my extension just calls our api and in returns gets the data it needs such as max discount, availbility, and other helpful values.

Goal: I need you to write the cron job for each provider, ensuring it updates the db correctly. I will be outlining the api/methods we have for each provider. Alongside this we need a cron job for calling the cardbear api, where we will check for gcx and arbitrage card in "highestDiscountReseller" and if present update the brand in our db with its new max value / discount percentage for that provider. Finally, we should expose a api that my frontend can call. Any cron jobs or private apis we have should be secure, if you need to create api keys im okay with that. Not sure if thats possible with the exposed api but if it is we can implement it. This is a high level plan I thought of but you have the final design choice on how it should be structure and what cron jobs we should have. It can differ from mine, you have full control on how you want to implement it, choose the best design and implementation.

## API'S WE CAN USE DIRECTLY TO UPDATE OUR DB

- **🟢 CardCash 🟢**:

  - Preface: We have a partnership with cardcash so for each cardcash url, we only want to serve our affliate link in the final response, my db doesn't have this seeded yet so its something we need to fix as well, heres the api from rakuten which generates our deep link for cardcash urls

    ```jamesb@Jamess-Mac-mini ~ % curl -X POST "https://api.linksynergy.com/v1/links/deep_links" \
    -H "Authorization: Bearer bP3ejw9J7Ec6zsLTOB5iwsHMLPOcilJT" \
    -H "Content-Type: application/json" \
    -d '{
        "url": "https://www.cardcash.com/buy-gift-cards/discount-starbucks-cards/",
        "advertiser_id": 45394
    }'

    {
    "_metadata": {
        "api_name_version": "links-deep-links-v1.0.0"
    },
    "advertiser": {
        "id": 45394,
        "name": "CardCash",
        "url": "https://www.cardcash.com/",
        "deep_link": {
        "deep_link_url": "https://click.linksynergy.com/deeplink?id=boIinK7DrQw\u0026mid=45394\u0026murl=https%3A%2F%2Fwww.cardcash.com%2Fbuy-gift-cards%2Fdiscount-starbucks-cards%2F",
        "u1": "",
        "url": "https%3A%2F%2Fwww.cardcash.com%2Fbuy-gift-cards%2Fdiscount-starbucks-cards%2F"
        }
    }
    }%
    ```

  - Summary: Cardcash has a endpoint that returns all the data we need, the only issue is it requires a anonymous cookie to make the request. This cookie will be generated using an external script that will be fed to the worker when it needs to reach the endpoint and extract the latest data.
  - CardCash exposes the following api endpoint on their site: "https://production-api.cardcash.com/v3/merchants/buy?cache=bust". This GET request requires a cookie which is generated using playwright and has a time expiration of 20 minutes. The cookie will be supplied to the worker upon request. The response from this endpoint contains the entire gift card list and all the params we need, which means we only make one api call for each cron. Heres a snippet of the response
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

  - Summary: I've tried to find endpoints on the cardcookie website but theres none that is available on the frontend, but going to keep trying. The currents solution is to scrap the homepage which contains all the cards available and their discount.
  - CardCookie doesn't expose any endpoints on its site, however, we can reach the entire list of cards on their landing page "https://cardcookie.com/". Heres the sample response
  - ```
    <div class="row gift-card-grid"><div class="giftCard"><a id="link-target" data="8%" href="/buy-gift-cards/target" title="Target (online only)" class="giftCard-link"><div style="background-color:#CC0000" class="gcr-wrapper"><p class="gcr-placeholder">Target</p><img src="/img/brand-cards/target.2BA4F9F3DFE76BCA4AFB97CFF6E1A1.cached.svg" alt="buy target discounted gift card" class="gcr-img"></div><span class="giftCard-name">Target (online only)</span><span class="giftCard-discount">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-walmart" data="5%" href="/buy-gift-cards/walmart" title="Walmart" class="giftCard-link"><div style="background-color:#1A75CF" class="gcr-wrapper"><p class="gcr-placeholder">Walmart</p><img src="/img/brand-cards/walmart.91A734F0CC5A1BC356EA94514798977.cached.svg" alt="buy walmart discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Walmart Sale!</span><span class="giftCard-discount onSale">Save Up to 5%</span></a></div><div class="giftCard"><a id="link-best-buy" data="9%" href="/buy-gift-cards/best-buy" title="Best Buy" class="giftCard-link"><div style="background-color:#013D6B" class="gcr-wrapper"><p class="gcr-placeholder">Best Buy</p><img src="/img/brand-cards/best-buy.CDDCAE1B78A36FBB87A2ADFDFA4C1A8E.cached.svg" alt="buy best-buy discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Best Buy Sale!</span><span class="giftCard-discount onSale">Save Up to 9%</span></a></div><div class="giftCard"><a id="link-home-depot" data="8%" href="/buy-gift-cards/home-depot" title="Home Depot" class="giftCard-link"><div style="background-color:#FF6600" class="gcr-wrapper"><p class="gcr-placeholder">Home Depot</p><img src="/img/brand-cards/home-depot.48BB6F83656D234B4BAC4FF68BB1915.cached.svg" alt="buy home-depot discounted gift card" class="gcr-img"></div><span class="giftCard-name">Home Depot</span><span class="giftCard-discount">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-lowes" data="10%" href="/buy-gift-cards/lowes" title="Lowe's" class="giftCard-link"><div style="background-color:#224185" class="gcr-wrapper"><p class="gcr-placeholder">Lowe's</p><img src="/img/brand-cards/lowes.8391EEFDB264376FB9D347FB449FE66.cached.svg" alt="buy lowes discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Lowe's Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-dicks-sporting-goods" data="8%" href="/buy-gift-cards/dicks-sporting-goods" title="Dick's Sporting Goods" class="giftCard-link"><div style="background-color:#006554" class="gcr-wrapper"><p class="gcr-placeholder">Dick's Sporting Goods</p><img src="/img/brand-cards/dicks-sporting-goods.93F4EC86552952F11616FD5A5CBC6D0.cached.svg" alt="buy dicks-sporting-goods discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Dick's Sporting Goods Sale!</span><span class="giftCard-discount onSale">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-jcpenney" data="15%" href="/buy-gift-cards/jcpenney" title="JCPenney" class="giftCard-link"><div style="background-color:#CC0033" class="gcr-wrapper"><p class="gcr-placeholder">JCPenney</p><img src="/img/brand-cards/jcpenney.24D1C2CC839AF2935AE7BE8BD75C793.cached.svg" alt="buy jcpenney discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">JCPenney Sale!</span><span class="giftCard-discount onSale">Save Up to 15%</span></a></div><div class="giftCard"><a id="link-banana-republic" data="10%" href="/buy-gift-cards/banana-republic" title="Banana Republic" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Banana Republic</p><img src="/img/brand-cards/banana-republic.F6A2924F52B832589EA8256E3A97C69.cached.svg" alt="buy banana-republic discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Banana Republic Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-peets-coffee-and-tea" data="20%" href="/buy-gift-cards/peets-coffee-and-tea" title="Peet's Coffee &amp; Tea" class="giftCard-link"><div style="background-color:#2A1708" class="gcr-wrapper"><p class="gcr-placeholder">Peet's Coffee &amp; Tea</p><img src="/img/brand-cards/peets-coffee-and-tea.EFF48F31EDC8805B9929B2FB5FC13.cached.svg" alt="buy peets-coffee-and-tea discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Peet's Coffee &amp; Tea Sale!</span><span class="giftCard-discount onSale">Save Up to 20%</span></a></div><div class="giftCard"><a id="link-williams-sonoma" data="10%" href="/buy-gift-cards/williams-sonoma" title="Williams Sonoma" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Williams Sonoma</p><img src="/img/brand-cards/williams-sonoma.3CB7BE55AB3658DC66815CF675518593.cached.svg" alt="buy williams-sonoma discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Williams Sonoma Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-pottery-barn" data="12%" href="/buy-gift-cards/pottery-barn" title="Pottery Barn" class="giftCard-link"><div style="background-color:#663333" class="gcr-wrapper"><p class="gcr-placeholder">Pottery Barn</p><img src="/img/brand-cards/pottery-barn.98F9BCE24924D5F5A86DCC5D8849FA28.cached.svg" alt="buy pottery-barn discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Pottery Barn Sale!</span><span class="giftCard-discount onSale">Save Up to 12%</span></a></div><div class="giftCard"><a id="link-nike" data="10%" href="/buy-gift-cards/nike" title="Nike" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Nike</p><img src="/img/brand-cards/nike.BD9F78DD8C11E451CB8BA2F8B42A2524.cached.svg" alt="buy nike discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Nike Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-aeropostale" data="20%" href="/buy-gift-cards/aeropostale" title="Aeropostale" class="giftCard-link"><div style="background-color:#002D62" class="gcr-wrapper"><p class="gcr-placeholder">Aeropostale</p><img src="/img/brand-cards/aeropostale.6A9AF0831FBCA81781EDD7F9B5068C.cached.svg" alt="buy aeropostale discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Aeropostale Sale!</span><span class="giftCard-discount onSale">Save Up to 20%</span></a></div><div class="giftCard"><a id="link-crate-and-barrel" data="9%" href="/buy-gift-cards/crate-and-barrel" title="Crate &amp; Barrel" class="giftCard-link"><div style="background-color:#CCCCCC" class="gcr-wrapper"><p class="gcr-placeholder">Crate &amp; Barrel</p><img src="/img/brand-cards/crate-and-barrel.CA7C2A9C651D5D9426F6E259BAC1B7.cached.svg" alt="buy crate-and-barrel discounted gift card" class="gcr-img"></div><span class="giftCard-name">Crate &amp; Barrel</span><span class="giftCard-discount">Save Up to 9%</span></a></div><div class="giftCard"><a id="link-yankee-candle" data="10%" href="/buy-gift-cards/yankee-candle" title="Yankee Candle" class="giftCard-link"><div style="background-color:#EFBB2B" class="gcr-wrapper"><p class="gcr-placeholder">Yankee Candle</p><img src="/img/brand-cards/yankee-candle.FA2C680AA16EEEF639B64B12BC34F.cached.svg" alt="buy yankee-candle discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Yankee Candle Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-tiffany-and-co" data="15%" href="/buy-gift-cards/tiffany-and-co" title="Tiffany &amp; Co" class="giftCard-link"><div style="background-color:#81d8d0" class="gcr-wrapper"><p class="gcr-placeholder">Tiffany &amp; Co</p><img src="/img/brand-cards/tiffany-and-co.1D417E5C4F28FBF2333B7473AABB3E4E.cached.svg" alt="buy tiffany-and-co discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Tiffany &amp; Co Sale!</span><span class="giftCard-discount onSale">Save Up to 15%</span></a></div><div class="giftCard"><a id="link-aerosoles" data="5%" href="/buy-gift-cards/aerosoles" title="Aerosoles" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Aerosoles</p><img src="/img/brand-cards/aerosoles.A84861D79DE974274EA8666EB2A7294.cached.svg" alt="buy aerosoles discounted gift card" class="gcr-img"></div><span class="giftCard-name">Aerosoles</span><span class="giftCard-discount">Save Up to 5%</span></a></div><div class="giftCard"><a id="link-cb2" data="8%" href="/buy-gift-cards/cb2" title="CB2" class="giftCard-link"><div style="background-color:#E54100" class="gcr-wrapper"><p class="gcr-placeholder">CB2</p><img src="/img/brand-cards/cb2.EDA5777794F75B6F4E85CED6398D27F.cached.svg" alt="buy cb2 discounted gift card" class="gcr-img"></div><span class="giftCard-name">CB2</span><span class="giftCard-discount">Save Up to 8%</span></a></div><div class="giftCard"><a id="link-hotelscom" data="10%" href="/buy-gift-cards/hotelscom" title="Hotels.com" class="giftCard-link"><div style="background-color:#e4e3e3" class="gcr-wrapper"><p class="gcr-placeholder">Hotels.com</p><img src="/img/brand-cards/hotelscom.EB2C94EA912A99E415C6182FE4BFCA.cached.svg" alt="buy hotelscom discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Hotels.com Sale!</span><span class="giftCard-discount onSale">Save Up to 10%</span></a></div><div class="giftCard"><a id="link-newegg" data="5%" href="/buy-gift-cards/newegg" title="Newegg" class="giftCard-link"><div style="background-color:#929292" class="gcr-wrapper"><p class="gcr-placeholder">Newegg</p><img src="/img/brand-cards/newegg.FB7432F82DE856AB82A27512D5349ED9.cached.svg" alt="buy newegg discounted gift card" class="gcr-img"></div><span class="giftCard-name">Newegg</span><span class="giftCard-discount">Save Up to 5%</span></a></div><div class="giftCard"><a id="link-callaway-golf" data="20%" href="/buy-gift-cards/callaway-golf" title="Callaway Golf" class="giftCard-link"><div style="background-color:#6f6f6f" class="gcr-wrapper"><p class="gcr-placeholder">Callaway Golf</p><img src="/img/brand-cards/callaway-golf.23E0FEAA5549CFC5F32B71FDA316F9A3.cached.svg" alt="buy callaway-golf discounted gift card" class="gcr-img"></div><span class="giftCard-name onSale">Callaway Golf Sale!</span><span class="giftCard-discount onSale">Save Up to 20%</span></a></div><div class="giftCard"><a id="link-kohls" data="10%" href="/buy-gift-cards/kohls" title="Kohl's" class="giftCard-link"><div style="background-color:#000000" class="gcr-wrapper"><p class="gcr-placeholder">Kohl's</p><img src="/img/brand-cards/kohls.C97CF9141DEFE61A29816D6B0B8861C.cached.svg" alt="buy kohls discounted gift card" class="gcr-img"></div><span class="giftCard-name">Kohl's</span><span class="giftCard-discount">Save Up to 10%</span></a></div><div class="giftCard"></div><div class="giftCard"></div><div class="giftCard"></div><div class="giftCard"></div></div>
    ```
    - Using the html we get back we extract the max discount and availability.

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

- **🟢CardDepot🟢**:

  - From CardDepot dev team:

  " Thank you for your patience. Here is the API endpoint for you to use:
  https://carddepot.com/api/brands?type=savely
  For UTM tracking, please use the following parameters:
  UTM_Source: Savely
  UTM_Medium: partner
  UTM_Campaign: (merchant)
  Example: https://carddepot.com/brands/discount-apple-gift-cards?utm_source=savely&utm_medium=partner&utm_campaign=apple "

  - Snippet of Response:

  ```
  [
  {
      "title": "1-800 Baskets",
      "slug": "discount-1-800-baskets-gift-cards",
      "is_stock": true,
      "discount": 9,
      "image_url": "https://carddepot.com/storage/brands/discount-1-800-baskets-gift-cards.png",
      "q": "1800baskets",
      "categories": "Flower & Gifts"
  },
  {
      "title": "1-800-Flowers",
      "slug": "discount-1-800-flowers-gift-cards",
      "is_stock": true,
      "discount": 9,
      "image_url": "https://carddepot.com/storage/brands/discount-1-800-flowers-gift-cards.svg",
      "q": "1800flowers",
      "categories": "Flower & Gifts"
  },
  {
      "title": "1-800-PetSupplies",
      "slug": "discount-1-800-petsupplies-gift-cards",
      "is_stock": true,
      "discount": 6.5,
      "image_url": "https://carddepot.com/storage/brands/discount-1-800-petsupplies-gift-cards.png",
      "q": "1800petsupplies",
      "categories": "Pets"
  },
  {
      "title": "76 Gas (Fuel Forward App Only)",
      "slug": "discount-76-conoco-phillips-gas-gift-cards",
      "is_stock": false,
      "discount": 0,
      "image_url": "https://carddepot.com/storage/brands/discount-76-conoco-phillips-gas-gift-cards.jpg",
      "q": "76gasfuelforwardapponly",
      "categories": "Gas & Auto"
  },
  {
      "title": "Abercrombie & Fitch",
      "slug": "abercrombie-fitch",
      "is_stock": true,
      "discount": 5,
      "image_url": "https://carddepot.com/storage/brands/abercrombie-fitch.svg",
      "q": "abercrombiefitch",
      "categories": "Apparel"
  },
  ```

## PROVIDERS THAT REQUIRE DATABEAR API

---

- **🟡CardBear🟡**:
  - The CardBear API responds with the following
  ```
  {"discounts":[ {"storeName":"1-800 Flowers", "id":"158", "url":"http://www.cardbear.com/gift-card-discount/158/1-800+Flowers", "highestDiscount":"15.20", "highestDiscountReseller":"cardcash"}, {"storeName":"1-800 Pet Supplies", "id":"528", "url":"http://www.cardbear.com/gift-card-discount/528/1-800+Pet+Supplies", "highestDiscount":"9.00", "highestDiscountReseller":"raisecashback"}, {"storeName":"1800Baskets.com", "id":"654", "url":"http://www.cardbear.com/gift-card-discount/654/1800Baskets.com", "highestDiscount":"15.20", "highestDiscountReseller":"cardcash"}, {"storeName":"7 For All Mankind", "id":"145", "url":"http://www.cardbear.com/gift-card-discount/145/7+For+All+Mankind", "highestDiscount":"0.00", "highestDiscountReseller":"cardcash"}, {"storeName":"7-Eleven", "id":"766", "url":"http://www.cardbear.com/gift-card-discount/766/7-Eleven", "highestDiscount":"0.00", "highestDiscountReseller":"cardcash"}, {"storeName":"76 Gas", "id":"496", "url":"http://www.cardbear.com/gift-card-discount/496/76+Gas", "highestDiscount":"0.00", "highestDiscountReseller":"cardcash"}, {"storeName":"85C Bakery Cafe", "id":"870", "url":"http://www.cardbear.com/gift-card-discount/870/85C+Bakery+Cafe", "highestDiscount":"19.00", "highestDiscountReseller":"giftcardsaving"}, {"storeName":"A.C. Moore", "id":"146", "url":"http://www.cardbear.com/gift-card-discount/146/A.C.+Moore", "highestDiscount":"0.00", "highestDiscountReseller":"cardcash"}, {"storeName":"Aaron Brothers", "id":"147", "url":"http://www.cardbear.com/gift-card-discount/147/Aaron+Brothers", "highestDiscount":"0.00", "highestDiscountReseller":"cardcash"}, {"storeName":"Abercrombie & Fitch", "id":"3", "url":"http://www.cardbear.com/gift-card-discount/3/Abercrombie+%26+Fitch", "highestDiscount":"5.50", "highestDiscountReseller":"cardcash"}, {"storeName":"Abercrombie Kids", "id":"249", "url":"http://www.cardbear.com/gift-card-discount/249/Abercrombie+Kids", "highestDiscount":"4.00", "highestDiscountReseller":"raisecashback"}, {"storeName":"Abuelo's", "id":"676", "url":"http://www.cardbear.com/gift-card-discount/676/Abuelo%27s", "highestDiscount":"0.00", "highestDiscountReseller":"giftcardsaving"}, {"storeName":"Academy Sports", "id":"148", "url":"http://www.cardbear.com/gift-card-discount/148/Academy+Sports", "highestDiscount":"20.00", "highestDiscountReseller":"spoofee"}, {"storeName":"Ace Hardware", "id":"323", "url":"http://www.cardbear.com/gift-card-discount/323/Ace+Hardware", "highestDiscount":"16.00", "highestDiscountReseller":"carddepot"}, {"storeName":"Acme Fresh Market", "id":"719", "url":"http://www.cardbear.com/gift-card-discount/719/Acme+Fresh+Market", "highestDiscount":"4.00", "highestDiscountReseller":"cardcash"}, {"storeName":"Adidas", "id":"43", "url":"http://www.cardbear.com/gift-card-discount/43/Adidas", "highestDiscount":"10.20", "highestDiscountReseller":"arbitrage"},
  ```
  - It's important to note that the provider "gcx" in our db is also known as "raise" and "raisecashback" in databear's api. also "arbitragecard" in our db is simply "arbitrage" in databear's api.
