exports.handler = async function(event, context) {
  const username = 'biomedhubiq';
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    const response = await fetch(`https://www.instagram.com/${username}/?__a=1&__d=dis`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) throw new Error('Failed to fetch Instagram');

    const data = await response.json();
    const count = data?.graphql?.user?.edge_followed_by?.count || 2610;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ followers: count })
    };
  } catch (error) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ followers: 2610 })
    };
  }
};

