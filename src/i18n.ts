/**
 * Internationalization (i18n) module for the Raffle Bot.
 * Provides translated strings for multiple languages.
 */

type Translations = Record<string, Record<string, string>>;

const translations: Translations = {
  en: {
    // Raffle display
    "raffle.prize": "Prize",
    "raffle.prizes": "Prizes",
    "raffle.entries": "Entries",
    "raffle.winners": "Winners",
    "raffle.ends": "Ends",
    "raffle.opens": "Opens",
    "raffle.hidden_entries": "Entries: Hidden until draw",
    "raffle.sponsored_by": "Sponsored by",
    "raffle.created_by": "Created by",
    "raffle.enter_cta": "Tap the button below to enter!",
    "raffle.closed": "This raffle is closed.",
    "raffle.drawn": "Winners have been drawn!",
    "raffle.ended": "This raffle has ended!",

    // Buttons
    "btn.enter": "Enter Raffle",
    "btn.leave": "Leave",
    "btn.entries": "Entries ({count})",

    // Winner announcement
    "winner.title": "Raffle Drawn: {title}",
    "winner.label": "Winner",
    "winner.label_plural": "Winners",
    "winner.congratulations": "Congratulations!",
    "winner.no_entries": "No entries were received. No winners selected.",
    "winner.congrats_footer": "Congratulations!",
    "winner.dm_won": "You won in the raffle <b>{title}</b>!",
    "winner.dm_prize": "Your prize: {prize}",
    "winner.dm_sponsor": "Sponsor: {sponsor}\nContact them to claim your prize!",
    "winner.dm_won_in": "Won in <b>{group}</b>",

    // Wheel spin
    "spin.drawing": "Drawing winners for {title}...",
    "spin.spinning": "Spinning the wheel...",
    "spin.winner_is": "And the winner is...",

    // Entry responses
    "entry.success": "You're in! Good luck!",
    "entry.already": "You already entered this raffle!",
    "entry.full": "This raffle is full.",
    "entry.expired": "This raffle has expired.",
    "entry.not_open": "This raffle hasn't opened yet.",
    "entry.left": "You've left the raffle.",
    "entry.not_in": "You weren't in this raffle.",

    // Misc
    "misc.no_open_raffles": "No open raffles in this chat.",
    "misc.raffle_not_found": "Raffle not found.",
    "misc.admin_only": "Only group admins can do this.",
    "misc.group_only": "Use this command in a group chat.",
    "misc.lang_set": "Language set to {lang}.",
    "misc.lang_current": "Current language: {lang}",
  },

  es: {
    "raffle.prize": "Premio",
    "raffle.prizes": "Premios",
    "raffle.entries": "Participantes",
    "raffle.winners": "Ganadores",
    "raffle.ends": "Termina",
    "raffle.opens": "Abre",
    "raffle.hidden_entries": "Participantes: Ocultos hasta el sorteo",
    "raffle.sponsored_by": "Patrocinado por",
    "raffle.created_by": "Creado por",
    "raffle.enter_cta": "Toca el boton para participar!",
    "raffle.closed": "Este sorteo esta cerrado.",
    "raffle.drawn": "Los ganadores han sido seleccionados!",
    "raffle.ended": "Este sorteo ha terminado!",

    "btn.enter": "Participar",
    "btn.leave": "Salir",
    "btn.entries": "Participantes ({count})",

    "winner.title": "Sorteo: {title}",
    "winner.label": "Ganador",
    "winner.label_plural": "Ganadores",
    "winner.congratulations": "Felicidades!",
    "winner.no_entries": "No se recibieron participaciones. Sin ganadores.",
    "winner.congrats_footer": "Felicidades!",
    "winner.dm_won": "Ganaste en el sorteo <b>{title}</b>!",
    "winner.dm_prize": "Tu premio: {prize}",
    "winner.dm_sponsor": "Patrocinador: {sponsor}\nContactalos para reclamar tu premio!",
    "winner.dm_won_in": "Ganaste en <b>{group}</b>",

    "spin.drawing": "Seleccionando ganadores de {title}...",
    "spin.spinning": "Girando la ruleta...",
    "spin.winner_is": "Y el ganador es...",

    "entry.success": "Estas dentro! Buena suerte!",
    "entry.already": "Ya participas en este sorteo!",
    "entry.full": "Este sorteo esta lleno.",
    "entry.expired": "Este sorteo ha expirado.",
    "entry.not_open": "Este sorteo aun no esta abierto.",
    "entry.left": "Has salido del sorteo.",
    "entry.not_in": "No estabas en este sorteo.",

    "misc.no_open_raffles": "No hay sorteos abiertos en este chat.",
    "misc.raffle_not_found": "Sorteo no encontrado.",
    "misc.admin_only": "Solo los administradores pueden hacer esto.",
    "misc.group_only": "Usa este comando en un chat grupal.",
    "misc.lang_set": "Idioma configurado a {lang}.",
    "misc.lang_current": "Idioma actual: {lang}",
  },

  pt: {
    "raffle.prize": "Premio",
    "raffle.prizes": "Premios",
    "raffle.entries": "Participantes",
    "raffle.winners": "Vencedores",
    "raffle.ends": "Termina",
    "raffle.opens": "Abre",
    "raffle.hidden_entries": "Participantes: Ocultos ate o sorteio",
    "raffle.sponsored_by": "Patrocinado por",
    "raffle.created_by": "Criado por",
    "raffle.enter_cta": "Toque no botao para participar!",
    "raffle.closed": "Este sorteio esta encerrado.",
    "raffle.drawn": "Os vencedores foram selecionados!",
    "raffle.ended": "Este sorteio terminou!",

    "btn.enter": "Participar",
    "btn.leave": "Sair",
    "btn.entries": "Participantes ({count})",

    "winner.title": "Sorteio: {title}",
    "winner.label": "Vencedor",
    "winner.label_plural": "Vencedores",
    "winner.congratulations": "Parabens!",
    "winner.no_entries": "Nenhuma participacao recebida. Sem vencedores.",
    "winner.congrats_footer": "Parabens!",
    "winner.dm_won": "Voce ganhou no sorteio <b>{title}</b>!",
    "winner.dm_prize": "Seu premio: {prize}",
    "winner.dm_sponsor": "Patrocinador: {sponsor}\nEntre em contato para resgatar seu premio!",
    "winner.dm_won_in": "Ganhou em <b>{group}</b>",

    "spin.drawing": "Selecionando vencedores de {title}...",
    "spin.spinning": "Girando a roleta...",
    "spin.winner_is": "E o vencedor e...",

    "entry.success": "Voce esta dentro! Boa sorte!",
    "entry.already": "Voce ja participa deste sorteio!",
    "entry.full": "Este sorteio esta cheio.",
    "entry.expired": "Este sorteio expirou.",
    "entry.not_open": "Este sorteio ainda nao abriu.",
    "entry.left": "Voce saiu do sorteio.",
    "entry.not_in": "Voce nao estava neste sorteio.",

    "misc.no_open_raffles": "Nenhum sorteio aberto neste chat.",
    "misc.raffle_not_found": "Sorteio nao encontrado.",
    "misc.admin_only": "Apenas administradores podem fazer isso.",
    "misc.group_only": "Use este comando em um chat de grupo.",
    "misc.lang_set": "Idioma definido para {lang}.",
    "misc.lang_current": "Idioma atual: {lang}",
  },

  ru: {
    "raffle.prize": "Приз",
    "raffle.prizes": "Призы",
    "raffle.entries": "Участники",
    "raffle.winners": "Победители",
    "raffle.ends": "Заканчивается",
    "raffle.opens": "Открывается",
    "raffle.hidden_entries": "Участники: Скрыты до розыгрыша",
    "raffle.sponsored_by": "Спонсор",
    "raffle.created_by": "Создал",
    "raffle.enter_cta": "Нажмите кнопку чтобы участвовать!",
    "raffle.closed": "Этот розыгрыш закрыт.",
    "raffle.drawn": "Победители определены!",
    "raffle.ended": "Этот розыгрыш завершен!",

    "btn.enter": "Участвовать",
    "btn.leave": "Выйти",
    "btn.entries": "Участники ({count})",

    "winner.title": "Розыгрыш: {title}",
    "winner.label": "Победитель",
    "winner.label_plural": "Победители",
    "winner.congratulations": "Поздравляем!",
    "winner.no_entries": "Нет участников. Победители не выбраны.",
    "winner.congrats_footer": "Поздравляем!",
    "winner.dm_won": "Вы выиграли в розыгрыше <b>{title}</b>!",
    "winner.dm_prize": "Ваш приз: {prize}",
    "winner.dm_sponsor": "Спонсор: {sponsor}\nСвяжитесь с ними для получения приза!",
    "winner.dm_won_in": "Выиграли в <b>{group}</b>",

    "spin.drawing": "Выбираем победителей {title}...",
    "spin.spinning": "Крутим колесо...",
    "spin.winner_is": "И победитель...",

    "entry.success": "Вы участвуете! Удачи!",
    "entry.already": "Вы уже участвуете!",
    "entry.full": "Розыгрыш заполнен.",
    "entry.expired": "Розыгрыш завершен.",
    "entry.not_open": "Розыгрыш еще не открыт.",
    "entry.left": "Вы вышли из розыгрыша.",
    "entry.not_in": "Вы не участвовали в этом розыгрыше.",

    "misc.no_open_raffles": "Нет активных розыгрышей в этом чате.",
    "misc.raffle_not_found": "Розыгрыш не найден.",
    "misc.admin_only": "Только администраторы могут это делать.",
    "misc.group_only": "Используйте эту команду в групповом чате.",
    "misc.lang_set": "Язык установлен: {lang}.",
    "misc.lang_current": "Текущий язык: {lang}",
  },

  fr: {
    "raffle.prize": "Prix",
    "raffle.prizes": "Prix",
    "raffle.entries": "Participants",
    "raffle.winners": "Gagnants",
    "raffle.ends": "Fin",
    "raffle.opens": "Ouverture",
    "raffle.hidden_entries": "Participants: Masques jusqu'au tirage",
    "raffle.sponsored_by": "Sponsorise par",
    "raffle.created_by": "Cree par",
    "raffle.enter_cta": "Appuyez sur le bouton pour participer!",
    "raffle.closed": "Ce tirage est ferme.",
    "raffle.drawn": "Les gagnants ont ete selectionnes!",
    "raffle.ended": "Ce tirage est termine!",

    "btn.enter": "Participer",
    "btn.leave": "Quitter",
    "btn.entries": "Participants ({count})",

    "winner.title": "Tirage: {title}",
    "winner.label": "Gagnant",
    "winner.label_plural": "Gagnants",
    "winner.congratulations": "Felicitations!",
    "winner.no_entries": "Aucune participation recue. Pas de gagnants.",
    "winner.congrats_footer": "Felicitations!",
    "winner.dm_won": "Vous avez gagne au tirage <b>{title}</b>!",
    "winner.dm_prize": "Votre prix: {prize}",
    "winner.dm_sponsor": "Sponsor: {sponsor}\nContactez-les pour reclamer votre prix!",
    "winner.dm_won_in": "Gagne dans <b>{group}</b>",

    "spin.drawing": "Selection des gagnants de {title}...",
    "spin.spinning": "La roue tourne...",
    "spin.winner_is": "Et le gagnant est...",

    "entry.success": "Vous participez! Bonne chance!",
    "entry.already": "Vous participez deja!",
    "entry.full": "Ce tirage est complet.",
    "entry.expired": "Ce tirage a expire.",
    "entry.not_open": "Ce tirage n'est pas encore ouvert.",
    "entry.left": "Vous avez quitte le tirage.",
    "entry.not_in": "Vous ne participiez pas a ce tirage.",

    "misc.no_open_raffles": "Aucun tirage ouvert dans ce chat.",
    "misc.raffle_not_found": "Tirage non trouve.",
    "misc.admin_only": "Seuls les administrateurs peuvent faire cela.",
    "misc.group_only": "Utilisez cette commande dans un chat de groupe.",
    "misc.lang_set": "Langue definie: {lang}.",
    "misc.lang_current": "Langue actuelle: {lang}",
  },

  de: {
    "raffle.prize": "Preis",
    "raffle.prizes": "Preise",
    "raffle.entries": "Teilnehmer",
    "raffle.winners": "Gewinner",
    "raffle.ends": "Endet",
    "raffle.opens": "Oeffnet",
    "raffle.hidden_entries": "Teilnehmer: Bis zur Ziehung verborgen",
    "raffle.sponsored_by": "Gesponsert von",
    "raffle.created_by": "Erstellt von",
    "raffle.enter_cta": "Tippe den Button um teilzunehmen!",
    "raffle.closed": "Diese Verlosung ist geschlossen.",
    "raffle.drawn": "Die Gewinner wurden gezogen!",
    "raffle.ended": "Diese Verlosung ist beendet!",

    "btn.enter": "Teilnehmen",
    "btn.leave": "Verlassen",
    "btn.entries": "Teilnehmer ({count})",

    "winner.title": "Verlosung: {title}",
    "winner.label": "Gewinner",
    "winner.label_plural": "Gewinner",
    "winner.congratulations": "Herzlichen Glueckwunsch!",
    "winner.no_entries": "Keine Teilnahmen erhalten. Keine Gewinner.",
    "winner.congrats_footer": "Herzlichen Glueckwunsch!",
    "winner.dm_won": "Du hast bei der Verlosung <b>{title}</b> gewonnen!",
    "winner.dm_prize": "Dein Preis: {prize}",
    "winner.dm_sponsor": "Sponsor: {sponsor}\nKontaktiere sie um deinen Preis zu erhalten!",
    "winner.dm_won_in": "Gewonnen in <b>{group}</b>",

    "spin.drawing": "Ziehe Gewinner fuer {title}...",
    "spin.spinning": "Das Rad dreht sich...",
    "spin.winner_is": "Und der Gewinner ist...",

    "entry.success": "Du bist dabei! Viel Glueck!",
    "entry.already": "Du nimmst bereits teil!",
    "entry.full": "Diese Verlosung ist voll.",
    "entry.expired": "Diese Verlosung ist abgelaufen.",
    "entry.not_open": "Diese Verlosung ist noch nicht offen.",
    "entry.left": "Du hast die Verlosung verlassen.",
    "entry.not_in": "Du warst nicht in dieser Verlosung.",

    "misc.no_open_raffles": "Keine offenen Verlosungen in diesem Chat.",
    "misc.raffle_not_found": "Verlosung nicht gefunden.",
    "misc.admin_only": "Nur Administratoren koennen das tun.",
    "misc.group_only": "Benutze diesen Befehl in einem Gruppenchat.",
    "misc.lang_set": "Sprache gesetzt: {lang}.",
    "misc.lang_current": "Aktuelle Sprache: {lang}",
  },
};

const languageNames: Record<string, string> = {
  en: "English",
  es: "Espanol",
  pt: "Portugues",
  ru: "Русский",
  fr: "Francais",
  de: "Deutsch",
};

/**
 * Get a translated string.
 * Falls back to English if the key is not found in the target language.
 */
export function t(
  lang: string,
  key: string,
  params?: Record<string, string | number>
): string {
  const langStrings = translations[lang] || translations.en;
  let str = langStrings[key] || translations.en[key] || key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }

  return str;
}

export function getLanguageName(code: string): string {
  return languageNames[code] || code;
}

export function getAvailableLanguages(): Array<{ code: string; name: string }> {
  return Object.entries(languageNames).map(([code, name]) => ({
    code,
    name,
  }));
}
