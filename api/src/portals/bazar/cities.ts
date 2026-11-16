/*
 * Bulgarian names for common Bulgarian towns, so the city label in the Bazar feed reads
 * the way Bazar's own location list does. Bazar's feed import publishes no location
 * reference list (to confirm during onboarding), so the label is only used for the
 * one-time mapping in Bazar's interface; unknown names pass through unchanged.
 */

const CITIES: readonly (readonly [cyrillic: string, ...latin: string[]])[] = [
  ['София', 'Sofia', 'Sofiya'],
  ['Пловдив', 'Plovdiv'],
  ['Варна', 'Varna'],
  ['Бургас', 'Burgas', 'Bourgas'],
  ['Русе', 'Ruse', 'Rousse'],
  ['Стара Загора', 'Stara Zagora'],
  ['Плевен', 'Pleven'],
  ['Сливен', 'Sliven'],
  ['Добрич', 'Dobrich'],
  ['Шумен', 'Shumen', 'Shoumen'],
  ['Перник', 'Pernik'],
  ['Хасково', 'Haskovo', 'Khaskovo'],
  ['Ямбол', 'Yambol'],
  ['Пазарджик', 'Pazardzhik', 'Pazardjik'],
  ['Благоевград', 'Blagoevgrad'],
  ['Велико Търново', 'Veliko Tarnovo', 'Veliko Turnovo'],
  ['Враца', 'Vratsa', 'Vratza'],
  ['Габрово', 'Gabrovo'],
  ['Асеновград', 'Asenovgrad'],
  ['Видин', 'Vidin'],
  ['Казанлък', 'Kazanlak', 'Kazanluk'],
  ['Кюстендил', 'Kyustendil'],
  ['Кърджали', 'Kardzhali', 'Kardjali', 'Kurdzhali'],
  ['Монтана', 'Montana'],
  ['Димитровград', 'Dimitrovgrad'],
  ['Търговище', 'Targovishte', 'Turgovishte'],
  ['Ловеч', 'Lovech'],
  ['Силистра', 'Silistra'],
  ['Разград', 'Razgrad'],
  ['Дупница', 'Dupnitsa', 'Dupnitza'],
  ['Горна Оряховица', 'Gorna Oryahovitsa'],
  ['Смолян', 'Smolyan'],
  ['Петрич', 'Petrich'],
  ['Сандански', 'Sandanski'],
  ['Самоков', 'Samokov'],
  ['Севлиево', 'Sevlievo'],
  ['Лом', 'Lom'],
  ['Карлово', 'Karlovo'],
  ['Велинград', 'Velingrad'],
  ['Нова Загора', 'Nova Zagora'],
  ['Троян', 'Troyan'],
  ['Айтос', 'Aytos', 'Aitos'],
  ['Ботевград', 'Botevgrad'],
  ['Гоце Делчев', 'Gotse Delchev'],
  ['Пещера', 'Peshtera'],
  ['Харманли', 'Harmanli'],
  ['Карнобат', 'Karnobat'],
  ['Свищов', 'Svishtov'],
  ['Панагюрище', 'Panagyurishte'],
  ['Чирпан', 'Chirpan'],
  ['Свиленград', 'Svilengrad'],
  ['Банско', 'Bansko'],
  ['Разлог', 'Razlog'],
  ['Несебър', 'Nesebar', 'Nessebar'],
  ['Созопол', 'Sozopol'],
  ['Поморие', 'Pomorie'],
  ['Приморско', 'Primorsko'],
  ['Царево', 'Tsarevo'],
  ['Обзор', 'Obzor'],
  ['Балчик', 'Balchik'],
  ['Каварна', 'Kavarna'],
  ['Слънчев бряг', 'Sunny Beach', 'Slanchev Bryag'],
  ['Златни пясъци', 'Golden Sands', 'Zlatni Pyasatsi'],
  ['Боровец', 'Borovets'],
  ['Пампорово', 'Pamporovo'],
  ['Чепеларе', 'Chepelare'],
  ['Хисаря', 'Hisarya', 'Hissarya'],
  ['Банкя', 'Bankya'],
  ['Костинброд', 'Kostinbrod'],
  ['Елин Пелин', 'Elin Pelin'],
  ['Аксаково', 'Aksakovo'],
  ['Девня', 'Devnya'],
  ['Провадия', 'Provadia', 'Provadiya'],
  ['Трявна', 'Tryavna'],
];

/** Lower case, no spaces, hyphens or dots, and 'y' read as 'i' (Sofiya = Sofia). */
function cityKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s.\-–'’]+/g, '')
    .replaceAll('y', 'i');
}

const BY_LATIN_KEY = new Map<string, string>(
  CITIES.flatMap(([cyrillic, ...latin]) => latin.map((name) => [cityKey(name), cyrillic] as const)),
);

const CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * The Bulgarian (Cyrillic) name of a town given in Latin letters, e.g. 'Sofia' -> 'София',
 * 'Veliko Turnovo' -> 'Велико Търново'. Names already in Cyrillic and towns not in the
 * list are returned trimmed but otherwise unchanged.
 */
export function toBulgarianCityName(city: string): string {
  const trimmed = city.trim().replace(/\s+/g, ' ');
  if (CYRILLIC.test(trimmed)) return trimmed;
  const withoutPrefix = trimmed.replace(/^(?:gr|grad|town of|city of)\.?\s+/i, '');
  return BY_LATIN_KEY.get(cityKey(withoutPrefix)) ?? trimmed;
}
